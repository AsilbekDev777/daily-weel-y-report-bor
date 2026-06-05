'use strict';

require('dotenv').config();
const axios  = require('axios');
const Database = require('better-sqlite3');
const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const config = {
  telegram: {
    token:   process.env.TELEGRAM_BOT_TOKEN,
    apiBase: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`
  },
  openai: {
    apiKey:             process.env.OPENAI_API_KEY,
    analysisModel:      process.env.OPENAI_ANALYSIS_MODEL      || 'gpt-4o-mini',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    delayMs:            parseInt(process.env.OPENAI_DELAY_MS   || '5000')
  },
  rc: {
    serverUrl:        process.env.RC_SERVER_URL     || 'https://platform.ringcentral.com',
    clientId:         process.env.RC_CLIENT_ID,
    clientSecret:     process.env.RC_CLIENT_SECRET,
    jwt:              process.env.RC_JWT,
    requestsPerMinute:parseInt(process.env.RC_REQUESTS_PER_MINUTE || '4'),
    perPage:          parseInt(process.env.RC_PER_PAGE            || '100'),
    maxPages:         parseInt(process.env.RC_MAX_PAGES           || '10')
  },
  bot: {
    databasePath:          process.env.DATABASE_PATH              || './data/bot.sqlite',
    downloadDir:           process.env.DOWNLOAD_DIR               || './data/recordings',
    maxAudioMb:            parseInt(process.env.MAX_AUDIO_MB      || '25'),
    maxAnalyzePerSync:     parseInt(process.env.MAX_ANALYZE_PER_SYNC || '4'),
    minCallDurationSeconds:parseInt(process.env.MIN_CALL_DURATION_SECONDS || '60'),
    lookbackMinutes:       parseInt(process.env.LOOKBACK_MINUTES  || '45'),
    backfillDays:          parseInt(process.env.BACKFILL_DAYS     || '7'),
    // GH_USERS = "TELEGRAM_ID:PHONE" pairs comma-separated
    // e.g. "123456789:+13125551234,987654321:+13129998877"
    ghUsers:  (process.env.GH_USERS || '').trim(),
    adminIds: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    debug:    process.env.DEBUG_MODE === 'true'
  },
  shift: { startHour: 8, endHour: 18, tz: 'America/Chicago' }
};

// ─── Logger ───────────────────────────────────────────────────────────────────

const log = {
  info:  (m) => console.log( `[INFO]  ${ts()} ${m}`),
  warn:  (m) => console.warn( `[WARN]  ${ts()} ${m}`),
  error: (m) => console.error(`[ERROR] ${ts()} ${m}`),
  debug: (m) => { if (config.bot.debug) console.log(`[DEBUG] ${ts()} ${m}`); }
};
function ts() { return new Date().toISOString(); }

// ─── Time helpers ─────────────────────────────────────────────────────────────

const CT_TZ = config.shift.tz;

/**
 * Returns current date string in CT as "YYYY-MM-DD".
 * FIX: uses Intl.DateTimeFormat instead of toISOString() to avoid UTC conversion.
 */
function todayDateCT() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CT_TZ }).format(new Date());
  // en-CA gives YYYY-MM-DD format natively
}

/**
 * Returns current hour (0-23) in CT.
 */
function currentHourCT() {
  return parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: CT_TZ, hour: 'numeric', hour12: false
  }).format(new Date()), 10);
}

function isShiftActive() {
  const h = currentHourCT();
  return h >= config.shift.startHour && h < config.shift.endHour;
}

/**
 * Convert a CT date string (YYYY-MM-DD) to UTC ISO boundaries.
 * Uses Intl API to get accurate DST-aware offset.
 */
function ctDayToUtcRange(ctDateStr) {
  // Parse the target date parts
  const [year, month, day] = ctDateStr.split('-').map(Number);

  // We need the UTC offset for CT on this specific date (DST-aware).
  // Strategy: create a known UTC time on that date, format in CT, compare.
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0)); // noon UTC
  const ctHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: CT_TZ, hour: 'numeric', hour12: false
  }).format(probe), 10);
  // noon UTC → ctHour in CT → offset = 12 - ctHour (positive = behind UTC)
  const offsetHours = 12 - ctHour; // e.g. CDT=5, CST=6

  // Start of CT day = midnight CT = offsetHours:00 UTC
  const fromUtc = new Date(Date.UTC(year, month - 1, day, offsetHours, 0, 0));
  // End of CT day = 23:59:59 CT = next day offsetHours - 1 second in UTC
  const toUtc   = new Date(Date.UTC(year, month - 1, day + 1, offsetHours, 0, -1));

  return {
    dateFrom: fromUtc.toISOString(),
    dateTo:   toUtc.toISOString()
  };
}

/**
 * Today's shift window in UTC (9 AM – 7 PM CT).
 */
function todayShiftUtcRange(ctDateStr) {
  const [year, month, day] = ctDateStr.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const ctHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: CT_TZ, hour: 'numeric', hour12: false
  }).format(probe), 10);
  const offsetHours = 12 - ctHour;

  // 9 AM CT = (9 + offsetHours) UTC
  const fromUtc = new Date(Date.UTC(year, month - 1, day, 9 + offsetHours, 0, 0));
  // 7 PM CT = (19 + offsetHours) UTC
  const toUtc   = new Date(Date.UTC(year, month - 1, day, 19 + offsetHours, 0, 0));

  return {
    dateFrom: fromUtc.toISOString(),
    dateTo:   toUtc.toISOString()
  };
}

function lookbackRange(minutes) {
  const now = new Date();
  return {
    dateFrom: new Date(now - minutes * 60000).toISOString(),
    dateTo:   now.toISOString()
  };
}

function lastNDaysRange(n) {
  const now = new Date();
  return { dateFrom: new Date(now - n * 86400000).toISOString(), dateTo: now.toISOString() };
}

function weekRangeEndingSaturday(satDateStr) {
  const [y, m, d] = satDateStr.split('-').map(Number);
  const sat = new Date(Date.UTC(y, m - 1, d));
  const mon = new Date(sat);
  mon.setUTCDate(sat.getUTCDate() - 5);
  return {
    weekStart: mon.toISOString().slice(0, 10),
    weekEnd:   sat.toISOString().slice(0, 10)
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Database ─────────────────────────────────────────────────────────────────

let _db = null;

function getDb() {
  if (_db) return _db;
  const dbPath = path.resolve(config.bot.databasePath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // FIX: handle corrupted/malformed SQLite from bad cache restore
  try {
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    // Integrity check — catches "malformed image" before any real query
    const check = _db.prepare('PRAGMA integrity_check').get();
    if (!check || check.integrity_check !== 'ok') {
      throw new Error(`Integrity check failed: ${JSON.stringify(check)}`);
    }
    _initSchema(_db);
    log.info(`DB ready: ${dbPath}`);
  } catch (e) {
    log.warn(`DB corrupted (${e.message}) — deleting and recreating fresh DB`);
    try { if (_db) { _db.close(); } } catch {}
    _db = null;
    // Backup corrupted file for debugging
    if (fs.existsSync(dbPath)) {
      const backup = dbPath + '.corrupt.' + Date.now();
      fs.renameSync(dbPath, backup);
      log.warn(`Corrupted DB backed up to: ${backup}`);
    }
    // Create fresh DB
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _initSchema(_db);
    log.info(`Fresh DB created: ${dbPath}`);
  }

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

function ensureGhUsers() {
  const raw = config.bot.ghUsers;
  if (!raw) return;
  const d = getDb();
  for (const pair of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 1) { log.warn(`Invalid GH_USERS entry: "${pair}"`); continue; }
    const telegramId = pair.slice(0, colonIdx).trim();
    const phone      = pair.slice(colonIdx + 1).trim();
    d.prepare(`
      INSERT INTO users (telegram_id, rc_phone_number)
      VALUES (?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        rc_phone_number = excluded.rc_phone_number,
        is_active = 1
    `).run(telegramId, phone);
    log.info(`GH_USERS: registered ${telegramId} → ${phone}`);
  }
}

const db = {
  getAllActiveUsers() {
    ensureGhUsers();
    const users = getDb().prepare(
      'SELECT * FROM users WHERE is_active = 1 AND rc_phone_number IS NOT NULL'
    ).all();
    log.info(`getAllActiveUsers: ${users.length} user(s)`);
    return users;
  },
  callExists(id) {
    return !!getDb().prepare('SELECT id FROM calls WHERE rc_call_id = ?').get(id);
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
      ORDER BY start_time ASC LIMIT ?
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
  // FIX: use UTC-converted CT boundaries instead of date(start_time) in UTC
  getCallsForDate(telegramId, ctDateStr) {
    const { dateFrom, dateTo } = ctDayToUtcRange(ctDateStr);
    log.debug(`getCallsForDate(${ctDateStr}): UTC ${dateFrom} → ${dateTo}`);
    return getDb().prepare(`
      SELECT * FROM calls
      WHERE telegram_id = ? AND start_time >= ? AND start_time <= ? AND analyzed = 1
      ORDER BY start_time ASC
    `).all(telegramId, dateFrom, dateTo);
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
      INSERT INTO daily_reviews
        (telegram_id, review_date, review_text, avg_score, total_calls, analyzed_calls)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(telegram_id, review_date) DO UPDATE SET
        review_text=excluded.review_text, avg_score=excluded.avg_score,
        total_calls=excluded.total_calls, analyzed_calls=excluded.analyzed_calls
    `).run(telegramId, date, text, avgScore, total, analyzed);
  },
  saveWeeklyReview(telegramId, weekStart, weekEnd, text, avgScore, total) {
    getDb().prepare(`
      INSERT INTO weekly_reviews
        (telegram_id, week_start, week_end, review_text, avg_score, total_calls)
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
  },

  /**
   * Delete all call records for a specific CT date after daily report is sent.
   * Keeps daily_reviews and weekly_reviews intact (needed for weekly report).
   * This ensures the next day starts with a clean slate.
   */
  deleteCallsForDate(telegramId, ctDateStr) {
    const { dateFrom, dateTo } = ctDayToUtcRange(ctDateStr);
    const result = getDb().prepare(`
      DELETE FROM calls
      WHERE telegram_id = ? AND start_time >= ? AND start_time <= ?
    `).run(telegramId, dateFrom, dateTo);
    log.info(`Cleanup: deleted ${result.changes} calls for ${telegramId} on ${ctDateStr}`);
    return result.changes;
  },

  /**
   * Safety net: delete all calls older than N days to prevent DB growing indefinitely.
   */
  deleteCallsOlderThan(days) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const result = getDb().prepare(`DELETE FROM calls WHERE start_time < ?`).run(cutoff);
    if (result.changes > 0) {
      log.info(`Cleanup: deleted ${result.changes} calls older than ${days} days`);
    }
    return result.changes;
  }
};

// ─── Telegram sender ──────────────────────────────────────────────────────────

async function tgSend(chatId, text) {
  for (const chunk of splitMsg(text)) {
    try {
      await axios.post(`${config.telegram.apiBase}/sendMessage`, {
        chat_id: chatId, text: chunk, parse_mode: 'Markdown'
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

// ─── RingCentral ──────────────────────────────────────────────────────────────

let _rcToken = null, _rcTokenExpiry = 0, _lastRcCall = 0;
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
  const url = endpoint.startsWith('http') ? endpoint : `${config.rc.serverUrl}${endpoint}`;
  try {
    const resp = await axios.get(url, { params, headers: { Authorization: `Bearer ${token}` }, timeout: 60000 });
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
        dateFrom, dateTo, perPage: config.rc.perPage, page,
        withRecording: true, type: 'Voice', view: 'Detailed'
      });
      const records = data.records || [];
      log.debug(`RC p${page}: ${records.length} records`);
      all.push(...records);
      if (records.length < config.rc.perPage || !data.navigation?.nextPage) break;
    } catch (e) { log.error(`fetchCallLogs p${page}: ${e.message}`); break; }
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
    const resp = await axios({ method: 'GET', url, responseType: 'stream', timeout: 120000,
      headers: { Authorization: `Bearer ${token}` } });
    const cl = parseInt(resp.headers['content-length'] || '0');
    if (cl > config.bot.maxAudioMb * 1048576) { log.warn(`Too large (${(cl/1048576).toFixed(1)}MB)`); return null; }
    await new Promise((res, rej) => {
      const w = fs.createWriteStream(filePath);
      resp.data.pipe(w);
      w.on('finish', res); w.on('error', rej);
    });
    const size = fs.statSync(filePath).size / 1048576;
    if (size > config.bot.maxAudioMb) { fs.unlinkSync(filePath); return null; }
    log.info(`Downloaded: ${filePath} (${size.toFixed(2)}MB)`);
    return filePath;
  } catch (e) {
    log.error(`download ${rcCallId}: ${e.message}`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return null;
  }
}

function parseRecord(record, telegramId, extensionId) {
  return {
    rcCallId: record.id, telegramId,
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
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: config.openai.transcriptionModel,
    language: 'en', response_format: 'text'
  });
  return typeof resp === 'string' ? resp : (resp.text || '');
}

async function analyzeCall(transcription, meta = {}) {
  const resp = await openai.chat.completions.create({
    model: config.openai.analysisModel,
    messages: [
      { role: 'system', content:
        `You are a professional call quality analyst. Analyze the call transcript for profanity, manners, communication, and behavior.
Respond ONLY with valid JSON, no markdown:
{"score":<0-100>,"profanity_detected":<bool>,"profanity_words":[],"manners_rating":"<Excellent|Good|Fair|Poor>","communication_rating":"<Excellent|Good|Fair|Poor>","behavior_summary":"<2-3 sentences>","strengths":"<string>","weaknesses":"<string>","advice":"<string>","short_review":"<1-2 sentences>"}
Score guide: 90-100 Excellent, 75-89 Good, 60-74 Fair, 40-59 Poor, 0-39 Unacceptable. Profanity = score below 60.` },
      { role: 'user', content: `Direction: ${meta.direction||'?'} | Duration: ${meta.durationSeconds||0}s | Date: ${meta.startTime||'?'}\n\nTranscript:\n"""\n${transcription}\n"""` }
    ],
    temperature: 0.3, max_tokens: 800
  });
  const raw = resp.choices[0]?.message?.content || '{}';
  try { return JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch { return { score:50, profanity_detected:false, profanity_words:[], manners_rating:'Fair',
    communication_rating:'Fair', behavior_summary:'Parse error.', strengths:'N/A',
    weaknesses:'N/A', advice:'Review manually.', short_review:'Analysis error.' }; }
}

async function generateDailySummary(calls, date) {
  if (!calls.length) return { summary: 'No calls analyzed during this shift.', overallScore: null, totalCalls: 0 };
  const scores = calls.map(c => c.analysis?.score).filter(s => typeof s === 'number');
  const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : null;
  const reviewsText = calls.map((c,i) => {
    const a = c.analysis || {};
    return `Call ${i+1} (${c.direction||'?'}, ${c.duration_seconds||0}s):\n  Score: ${a.score??'N/A'} | Profanity: ${a.profanity_detected?'YES – '+(a.profanity_words||[]).join(', '):'No'}\n  Manners: ${a.manners_rating||'?'} | Communication: ${a.communication_rating||'?'}\n  Review: ${a.short_review||'N/A'}\n  Advice: ${a.advice||'N/A'}`;
  }).join('\n\n');
  const resp = await openai.chat.completions.create({
    model: config.openai.analysisModel,
    messages: [
      { role:'system', content:'You are a professional call center performance coach. Write a constructive, specific, encouraging end-of-shift summary in English.' },
      { role:'user',   content:`Shift: ${date}\nCalls: ${calls.length}\nAvg Score: ${avg??'N/A'}/100\n\n${reviewsText}\n\nWrite a shift summary: overall assessment, key strengths, areas to improve, 3 action items for next shift, motivational closing.` }
    ],
    temperature: 0.5, max_tokens: 1200
  });
  return { summary: resp.choices[0]?.message?.content || 'Generation failed.', overallScore: avg, totalCalls: calls.length };
}

async function generateWeeklySummary(dailyReviews, weekStart, weekEnd) {
  if (!dailyReviews.length) return { summary: 'No data for this week.', overallScore: null, totalDays: 0 };
  const scores = dailyReviews.filter(r=>r.avg_score!=null).map(r=>r.avg_score);
  const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : null;
  const text = dailyReviews.map(r=>`${r.review_date} (${r.analyzed_calls} calls, avg: ${r.avg_score??'N/A'}):\n${r.review_text}\n---`).join('\n\n');
  const resp = await openai.chat.completions.create({
    model: config.openai.analysisModel,
    messages: [
      { role:'system', content:'You are a professional call center performance coach writing a weekly performance report. Write in English.' },
      { role:'user',   content:`Week: ${weekStart} → ${weekEnd}\nDays: ${dailyReviews.length}\nWeekly Avg: ${avg??'N/A'}/100\n\nDaily summaries:\n${text}\n\nWrite a weekly report: week overview, consistent strengths, recurring issues, best day, top 3 goals for next week, weekly rating, motivational close.` }
    ],
    temperature: 0.5, max_tokens: 1800
  });
  return { summary: resp.choices[0]?.message?.content || 'Generation failed.', overallScore: avg, totalDays: dailyReviews.length };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreEmoji(s) {
  if (s >= 90) return '🌟'; if (s >= 75) return '✅';
  if (s >= 60) return '🟡'; if (s >= 40) return '🟠'; return '🔴';
}

function safeJson(str) {
  try { return str ? JSON.parse(str) : {}; } catch { return {}; }
}

/**
 * Fetch → store → analyze all unanalyzed calls in a date range.
 * Used by both gh-daily and gh-weekly to be self-contained.
 */
async function syncAndAnalyzeCalls(user, dateFrom, dateTo) {
  const { telegram_id: telegramId, rc_extension_id: extensionId } = user;

  log.info(`syncAndAnalyzeCalls: ${telegramId} | ${dateFrom} → ${dateTo}`);

  // Fetch from RingCentral
  let rawCalls = [];
  try {
    rawCalls = await fetchCallLogs(dateFrom, dateTo, extensionId);
  } catch (e) {
    log.error(`fetchCallLogs: ${e.message}`);
    return;
  }

  // Store new calls
  let newCount = 0;
  for (const record of rawCalls) {
    if ((record.duration || 0) < config.bot.minCallDurationSeconds) continue;
    if (!record.recording?.contentUri) continue;
    if (!db.callExists(record.id)) {
      db.insertCall(parseRecord(record, telegramId, extensionId));
      newCount++;
    }
  }
  log.info(`Stored ${newCount} new calls`);

  // Analyze ALL unanalyzed (no per-sync limit here — daily job needs everything)
  const toAnalyze = db.getUnanalyzed(telegramId, 100);
  log.info(`${toAnalyze.length} calls to analyze`);

  for (const call of toAnalyze) {
    try {
      await analyzeSilently(call);
    } catch (e) {
      log.error(`analyzeSilently ${call.rc_call_id}: ${e.message}`);
    }
    await sleep(config.openai.delayMs);
  }
}

async function analyzeSilently(call) {
  log.info(`Analyzing ${call.rc_call_id}...`);

  let localFile = call.local_file;
  if (!localFile || !fs.existsSync(localFile)) {
    localFile = await downloadRecording(call.rc_call_id, call.recording_url);
    if (!localFile) { log.warn(`Download failed: ${call.rc_call_id}`); return; }
    db.updateCallLocalFile(call.rc_call_id, localFile);
  }

  let transcription;
  try { transcription = await transcribeAudio(localFile); }
  catch (e) { log.error(`Transcription: ${e.message}`); return; }
  if (!transcription || transcription.trim().length < 10) { log.warn(`Too short: ${call.rc_call_id}`); return; }

  let analysis;
  try { analysis = await analyzeCall(transcription, { direction: call.direction, durationSeconds: call.duration_seconds, startTime: call.start_time }); }
  catch (e) { log.error(`Analysis: ${e.message}`); return; }

  db.updateCallAnalysis(call.rc_call_id, transcription, analysis, analysis.score);
  log.info(`Analyzed ${call.rc_call_id} → score ${analysis.score}`);

  try { if (fs.existsSync(localFile)) fs.unlinkSync(localFile); } catch {}
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  config, log, db, tgSend,
  todayDateCT, currentHourCT, isShiftActive,
  ctDayToUtcRange, todayShiftUtcRange,
  lookbackRange, lastNDaysRange, weekRangeEndingSaturday, sleep,
  fetchCallLogs, downloadRecording, parseRecord,
  transcribeAudio, analyzeCall,
  generateDailySummary, generateWeeklySummary,
  syncAndAnalyzeCalls, analyzeSilently,
  scoreEmoji, safeJson
};
