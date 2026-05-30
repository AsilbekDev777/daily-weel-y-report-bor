'use strict';

/**
 * Shared utilities for GitHub Actions scripts.
 * Runs standalone without Telegraf — uses raw Telegram Bot API via axios.
 */

require('dotenv').config();
const axios = require('axios');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    apiBase: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    analysisModel: process.env.OPENAI_ANALYSIS_MODEL || 'gpt-4o-mini',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    delayMs: parseInt(process.env.OPENAI_DELAY_MS || '5000')
  },
  rc: {
    serverUrl: process.env.RC_SERVER_URL || 'https://platform.ringcentral.com',
    clientId: process.env.RC_CLIENT_ID,
    clientSecret: process.env.RC_CLIENT_SECRET,
    jwt: process.env.RC_JWT,
    requestsPerMinute: parseInt(process.env.RC_REQUESTS_PER_MINUTE || '4'),
    perPage: parseInt(process.env.RC_PER_PAGE || '100'),
    maxPages: parseInt(process.env.RC_MAX_PAGES || '10')
  },
  bot: {
    databasePath: process.env.DATABASE_PATH || './data/bot.sqlite',
    downloadDir: process.env.DOWNLOAD_DIR || './data/recordings',
    maxAudioMb: parseInt(process.env.MAX_AUDIO_MB || '25'),
    maxAnalyzePerSync: parseInt(process.env.MAX_ANALYZE_PER_SYNC || '4'),
    minCallDurationSeconds: parseInt(process.env.MIN_CALL_DURATION_SECONDS || '15'),
    lookbackMinutes: parseInt(process.env.LOOKBACK_MINUTES || '45'),
    backfillDays: parseInt(process.env.BACKFILL_DAYS || '7'),
    adminIds: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    debug: process.env.DEBUG_MODE === 'true'
  },
  shift: { startHour: 9, endHour: 19, tz: 'America/Chicago' }
};

// ─── Logger ───────────────────────────────────────────────────────────────────

const log = {
  info:  (msg) => console.log(`[INFO]  ${new Date().toISOString()} ${msg}`),
  warn:  (msg) => console.warn(`[WARN]  ${new Date().toISOString()} ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} ${msg}`),
  debug: (msg) => { if (config.bot.debug) console.log(`[DEBUG] ${new Date().toISOString()} ${msg}`); }
};

// ─── Time helpers ─────────────────────────────────────────────────────────────

function nowCT() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: config.shift.tz }));
}

function todayDateCT() {
  return nowCT().toISOString().slice(0, 10);
}

function isShiftActive() {
  const h = nowCT().getHours();
  return h >= config.shift.startHour && h < config.shift.endHour;
}

function lookbackRange(minutes) {
  const now = new Date();
  return {
    dateFrom: new Date(now - minutes * 60000).toISOString(),
    dateTo: now.toISOString()
  };
}

function lastNDaysRange(n) {
  const now = new Date();
  return {
    dateFrom: new Date(now - n * 86400000).toISOString(),
    dateTo: now.toISOString()
  };
}

/**
 * Get Mon-Sat range for the week ending on the given Saturday date string
 */
function weekRangeEndingSaturday(saturdayDateStr) {
  const sat = new Date(saturdayDateStr + 'T00:00:00');
  const mon = new Date(sat);
  mon.setDate(sat.getDate() - 5);
  return {
    weekStart: mon.toISOString().slice(0, 10),
    weekEnd: sat.toISOString().slice(0, 10)
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Database ─────────────────────────────────────────────────────────────────

let _db = null;

function getDb() {
  if (_db) return _db;
  const dbPath = path.resolve(config.bot.databasePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _initSchema(_db);
  log.info(`DB ready: ${dbPath}`);
  return _db;
}

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      rc_phone_number TEXT,
      rc_extension_id TEXT,
      registered_at TEXT DEFAULT (datetime('now')),
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rc_call_id TEXT UNIQUE NOT NULL,
      telegram_id TEXT NOT NULL,
      rc_extension_id TEXT,
      phone_number TEXT,
      direction TEXT,
      duration_seconds INTEGER,
      start_time TEXT,
      end_time TEXT,
      recording_url TEXT,
      local_file TEXT,
      transcription TEXT,
      analyzed INTEGER DEFAULT 0,
      analysis_json TEXT,
      score INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS daily_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      review_date TEXT NOT NULL,
      review_text TEXT,
      avg_score REAL,
      total_calls INTEGER,
      analyzed_calls INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(telegram_id, review_date)
    );
    CREATE TABLE IF NOT EXISTS weekly_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      review_text TEXT,
      avg_score REAL,
      total_calls INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(telegram_id, week_start)
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      last_synced_at TEXT
    );
  `);
}

const db = {
  getAllActiveUsers() {
    return getDb().prepare(
      'SELECT * FROM users WHERE is_active = 1 AND rc_phone_number IS NOT NULL'
    ).all();
  },
  callExists(rcCallId) {
    return !!getDb().prepare('SELECT id FROM calls WHERE rc_call_id = ?').get(rcCallId);
  },
  insertCall(c) {
    try {
      getDb().prepare(`
        INSERT OR IGNORE INTO calls
          (rc_call_id, telegram_id, rc_extension_id, phone_number, direction,
           duration_seconds, start_time, end_time, recording_url)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(c.rcCallId, c.telegramId, c.extensionId, c.phoneNumber, c.direction,
             c.durationSeconds, c.startTime, c.endTime, c.recordingUrl);
    } catch (e) { log.error(`insertCall: ${e.message}`); }
  },
  getUnanalyzed(telegramId, limit) {
    return getDb().prepare(`
      SELECT * FROM calls
      WHERE telegram_id = ? AND recording_url IS NOT NULL AND analyzed = 0
      ORDER BY start_time DESC LIMIT ?
    `).all(telegramId, limit);
  },
  updateCallAnalysis(rcCallId, transcription, analysisJson, score) {
    getDb().prepare(`
      UPDATE calls SET transcription=?, analysis_json=?, score=?, analyzed=1
      WHERE rc_call_id=?
    `).run(transcription, JSON.stringify(analysisJson), score, rcCallId);
  },
  updateCallLocalFile(rcCallId, localFile) {
    getDb().prepare('UPDATE calls SET local_file=? WHERE rc_call_id=?').run(localFile, rcCallId);
  },
  getCallsForDate(telegramId, dateStr) {
    return getDb().prepare(`
      SELECT * FROM calls
      WHERE telegram_id=? AND date(start_time)=? AND analyzed=1
      ORDER BY start_time ASC
    `).all(telegramId, dateStr);
  },
  getDailyReviews(telegramId, from, to) {
    return getDb().prepare(`
      SELECT * FROM daily_reviews
      WHERE telegram_id=? AND review_date>=? AND review_date<=?
      ORDER BY review_date ASC
    `).all(telegramId, from, to);
  },
  dailyReviewExists(telegramId, date) {
    return !!getDb().prepare(
      'SELECT id FROM daily_reviews WHERE telegram_id=? AND review_date=?'
    ).get(telegramId, date);
  },
  saveDailyReview(telegramId, date, text, avgScore, total, analyzed) {
    getDb().prepare(`
      INSERT INTO daily_reviews (telegram_id, review_date, review_text, avg_score, total_calls, analyzed_calls)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(telegram_id, review_date) DO UPDATE SET
        review_text=excluded.review_text, avg_score=excluded.avg_score,
        total_calls=excluded.total_calls, analyzed_calls=excluded.analyzed_calls
    `).run(telegramId, date, text, avgScore, total, analyzed);
  },
  saveWeeklyReview(telegramId, weekStart, weekEnd, text, avgScore, total) {
    getDb().prepare(`
      INSERT INTO weekly_reviews (telegram_id, week_start, week_end, review_text, avg_score, total_calls)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(telegram_id, week_start) DO UPDATE SET
        review_text=excluded.review_text, avg_score=excluded.avg_score,
        total_calls=excluded.total_calls
    `).run(telegramId, weekStart, weekEnd, text, avgScore, total);
  },
  weeklyReviewExists(telegramId, weekStart) {
    return !!getDb().prepare(
      'SELECT id FROM weekly_reviews WHERE telegram_id=? AND week_start=?'
    ).get(telegramId, weekStart);
  },
  setLastSyncedAt(telegramId, iso) {
    getDb().prepare(`
      INSERT INTO sync_state (telegram_id, last_synced_at) VALUES (?,?)
      ON CONFLICT(telegram_id) DO UPDATE SET last_synced_at=excluded.last_synced_at
    `).run(telegramId, iso);
  }
};

// ─── Telegram sender (raw HTTP, no Telegraf) ──────────────────────────────────

async function tgSend(chatId, text, extra = {}) {
  const chunks = splitMsg(text);
  for (const chunk of chunks) {
    try {
      await axios.post(`${config.telegram.apiBase}/sendMessage`, {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
        ...extra
      }, { timeout: 30000 });
    } catch (e) {
      log.error(`tgSend to ${chatId}: ${e.response?.data?.description || e.message}`);
    }
    await sleep(300);
  }
}

function splitMsg(text, max = 4000) {
  if (text.length <= max) return [text];
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > max) {
      if (cur) chunks.push(cur.trim());
      cur = line;
    } else {
      cur = cur ? cur + '\n' + line : line;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

// ─── RingCentral REST client ──────────────────────────────────────────────────

let _rcToken = null;
let _rcTokenExpiry = 0;
let _lastRcCall = 0;
const RC_DELAY = Math.ceil(60000 / config.rc.requestsPerMinute);

async function getRcToken() {
  if (_rcToken && Date.now() < _rcTokenExpiry) return _rcToken;
  const creds = Buffer.from(`${config.rc.clientId}:${config.rc.clientSecret}`).toString('base64');
  const resp = await axios.post(
    `${config.rc.serverUrl}/restapi/oauth/token`,
    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${config.rc.jwt}`,
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
  );
  _rcToken = resp.data.access_token;
  _rcTokenExpiry = Date.now() + (resp.data.expires_in - 300) * 1000;
  log.info('RC: token obtained');
  return _rcToken;
}

async function rcGet(endpoint, params = {}) {
  const elapsed = Date.now() - _lastRcCall;
  if (elapsed < RC_DELAY) await sleep(RC_DELAY - elapsed);
  _lastRcCall = Date.now();

  const token = await getRcToken();
  const url = endpoint.startsWith('http')
    ? endpoint
    : `${config.rc.serverUrl}${endpoint}`;
  try {
    const resp = await axios.get(url, {
      params,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000
    });
    return resp.data;
  } catch (e) {
    if (e.response?.status === 401) { _rcToken = null; _rcTokenExpiry = 0; }
    throw e;
  }
}

async function fetchCallLogs(dateFrom, dateTo, extensionId) {
  const all = [];
  for (let page = 1; page <= config.rc.maxPages; page++) {
    const endpoint = extensionId
      ? `/restapi/v1.0/account/~/extension/${extensionId}/call-log`
      : '/restapi/v1.0/account/~/call-log';
    try {
      const data = await rcGet(endpoint, {
        dateFrom, dateTo,
        perPage: config.rc.perPage, page,
        withRecording: true, type: 'Voice', view: 'Detailed'
      });
      const records = data.records || [];
      log.debug(`RC page ${page}: ${records.length} records`);
      all.push(...records);
      if (records.length < config.rc.perPage || !data.navigation?.nextPage) break;
    } catch (e) {
      log.error(`fetchCallLogs p${page}: ${e.message}`);
      break;
    }
  }
  log.info(`fetchCallLogs: ${all.length} total`);
  return all;
}

async function downloadRecording(rcCallId, url) {
  const dir = path.resolve(config.bot.downloadDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${rcCallId}.mp3`);
  if (fs.existsSync(filePath)) return filePath;

  const token = await getRcToken();
  try {
    const resp = await axios({ method: 'GET', url, responseType: 'stream',
      timeout: 120000, headers: { Authorization: `Bearer ${token}` } });

    const cl = parseInt(resp.headers['content-length'] || '0');
    if (cl > config.bot.maxAudioMb * 1048576) {
      log.warn(`Recording too large (${(cl/1048576).toFixed(1)}MB), skip`);
      return null;
    }

    await new Promise((res, rej) => {
      const w = fs.createWriteStream(filePath);
      resp.data.pipe(w);
      w.on('finish', res);
      w.on('error', rej);
    });

    const size = fs.statSync(filePath).size / 1048576;
    if (size > config.bot.maxAudioMb) { fs.unlinkSync(filePath); return null; }
    log.info(`Downloaded: ${filePath} (${size.toFixed(2)}MB)`);
    return filePath;
  } catch (e) {
    log.error(`downloadRecording ${rcCallId}: ${e.message}`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return null;
  }
}

function parseRecord(record, telegramId, extensionId) {
  return {
    rcCallId: record.id,
    telegramId,
    extensionId: extensionId || null,
    phoneNumber: record.from?.phoneNumber || record.to?.phoneNumber || null,
    direction: record.direction || null,
    durationSeconds: record.duration || 0,
    startTime: record.startTime || null,
    endTime: record.startTime
      ? new Date(new Date(record.startTime).getTime() + (record.duration || 0) * 1000).toISOString()
      : null,
    recordingUrl: record.recording?.contentUri || null
  };
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────

const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: config.openai.apiKey, timeout: 300000 });

async function transcribeAudio(filePath) {
  const { default: FormData } = await import('form-data');
  // Use openai SDK directly
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: config.openai.transcriptionModel,
    language: 'en',
    response_format: 'text'
  });
  return typeof resp === 'string' ? resp : (resp.text || '');
}

async function analyzeCall(transcription, meta = {}) {
  const system = `You are a professional call quality analyst evaluating a customer service call.
Analyze: profanity, manners, communication clarity, overall behavior.
Respond ONLY with valid JSON (no markdown fences):
{
  "score": <0-100>,
  "profanity_detected": <true|false>,
  "profanity_words": [],
  "manners_rating": "<Excellent|Good|Fair|Poor>",
  "communication_rating": "<Excellent|Good|Fair|Poor>",
  "behavior_summary": "<2-3 sentences>",
  "strengths": "<string>",
  "weaknesses": "<string or 'None identified'>",
  "advice": "<actionable advice>",
  "short_review": "<1-2 sentences>"
}
Scoring: 90-100 Excellent, 75-89 Good, 60-74 Fair, 40-59 Poor, 0-39 Unacceptable.
If profanity detected: score must be below 60.`;

  const resp = await openai.chat.completions.create({
    model: config.openai.analysisModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Direction: ${meta.direction||'?'}\nDuration: ${meta.durationSeconds||0}s\nDate: ${meta.startTime||'?'}\n\nTranscript:\n"""\n${transcription}\n"""` }
    ],
    temperature: 0.3, max_tokens: 800
  });

  const raw = resp.choices[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    log.warn('Failed to parse analysis JSON, using defaults');
    return { score: 50, profanity_detected: false, profanity_words: [],
      manners_rating: 'Fair', communication_rating: 'Fair',
      behavior_summary: 'Parse error.', strengths: 'N/A',
      weaknesses: 'N/A', advice: 'Review manually.', short_review: 'Analysis error.' };
  }
}

async function generateDailySummary(calls, date) {
  if (!calls.length) return { summary: 'No calls analyzed during this shift.', overallScore: null, totalCalls: 0 };

  const scores = calls.map(c => c.analysis?.score).filter(s => typeof s === 'number');
  const avg = scores.length ? Math.round(scores.reduce((a,b) => a+b,0) / scores.length) : null;

  const reviewsText = calls.map((c, i) => {
    const a = c.analysis || {};
    return `Call ${i+1} (${c.direction||'?'}, ${c.duration_seconds||0}s):
  Score: ${a.score??'N/A'} | Profanity: ${a.profanity_detected ? 'YES – '+a.profanity_words?.join(', ') : 'No'}
  Manners: ${a.manners_rating||'?'} | Communication: ${a.communication_rating||'?'}
  Review: ${a.short_review||'N/A'}
  Advice: ${a.advice||'N/A'}`;
  }).join('\n\n');

  const resp = await openai.chat.completions.create({
    model: config.openai.analysisModel,
    messages: [
      { role: 'system', content: 'You are a professional call center performance coach writing an end-of-shift summary. Be constructive, specific, and encouraging. Write in English.' },
      { role: 'user', content: `Shift: ${date}\nCalls: ${calls.length}\nAverage Score: ${avg??'N/A'}/100\n\n${reviewsText}\n\nWrite a shift summary with: overall assessment, key strengths, areas for improvement, 3 action items for next shift, motivational closing.` }
    ],
    temperature: 0.5, max_tokens: 1200
  });

  return { summary: resp.choices[0]?.message?.content || 'Generation failed.', overallScore: avg, totalCalls: calls.length };
}

async function generateWeeklySummary(dailyReviews, weekStart, weekEnd) {
  if (!dailyReviews.length) return { summary: 'No data for this week.', overallScore: null, totalDays: 0 };

  const scores = dailyReviews.filter(r => r.avg_score != null).map(r => r.avg_score);
  const avg = scores.length ? Math.round(scores.reduce((a,b) => a+b,0) / scores.length) : null;

  const text = dailyReviews.map(r =>
    `${r.review_date} (${r.analyzed_calls} calls, avg: ${r.avg_score??'N/A'}):\n${r.review_text}\n---`
  ).join('\n\n');

  const resp = await openai.chat.completions.create({
    model: config.openai.analysisModel,
    messages: [
      { role: 'system', content: 'You are a professional call center performance coach writing a weekly performance report. Write in English.' },
      { role: 'user', content: `Week: ${weekStart} → ${weekEnd}\nDays: ${dailyReviews.length}\nWeekly Average: ${avg??'N/A'}/100\n\nDaily summaries:\n${text}\n\nWrite a weekly report: week overview, consistent strengths, recurring issues, best day, top 3 goals for next week, weekly score/rating, motivational close.` }
    ],
    temperature: 0.5, max_tokens: 1800
  });

  return { summary: resp.choices[0]?.message?.content || 'Generation failed.', overallScore: avg, totalDays: dailyReviews.length };
}

// ─── Message formatting ───────────────────────────────────────────────────────

function scoreEmoji(s) {
  if (s >= 90) return '🌟'; if (s >= 75) return '✅';
  if (s >= 60) return '🟡'; if (s >= 40) return '🟠'; return '🔴';
}

function fmtCallReview(call, analysis) {
  const score = analysis.score ?? 0;
  let msg = `📞 *Call Review*\n`;
  msg += `🕐 ${(call.start_time||'').slice(11,16)} CT | ⏱ ${fmtDur(call.duration_seconds)}\n`;
  msg += `📊 Score: *${score}/100* ${scoreEmoji(score)}\n`;
  if (analysis.profanity_detected && analysis.profanity_words?.length) {
    msg += `\n🚫 *Profanity Detected:* \`${analysis.profanity_words.join(', ')}\`\n`;
  }
  msg += `\n📋 Manners: ${analysis.manners_rating||'N/A'} | 💬 Communication: ${analysis.communication_rating||'N/A'}\n`;
  if (analysis.behavior_summary) msg += `\n📝 ${analysis.behavior_summary}\n`;
  if (analysis.strengths && analysis.strengths !== 'None identified') msg += `\n✅ *Strengths:* ${analysis.strengths}\n`;
  if (analysis.weaknesses && analysis.weaknesses !== 'None identified') msg += `\n⚠️ *Improve:* ${analysis.weaknesses}\n`;
  if (analysis.advice) msg += `\n💡 *Advice:* ${analysis.advice}`;
  return msg;
}

function fmtDur(s) {
  if (!s) return '0s';
  const m = Math.floor(s/60), sec = s%60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  config, log, db, tgSend,
  isShiftActive, todayDateCT, lookbackRange, lastNDaysRange, weekRangeEndingSaturday, sleep,
  fetchCallLogs, downloadRecording, parseRecord,
  transcribeAudio, analyzeCall, generateDailySummary, generateWeeklySummary,
  fmtCallReview, scoreEmoji
};
