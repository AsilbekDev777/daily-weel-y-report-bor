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
    analysisModel:      process.env.OPENAI_ANALYSIS_MODEL      || 'gpt-5.5',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe',
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

const WORDS_SHORT_GH  = 2500;
const WORDS_MEDIUM_GH = 6000;

async function compressTranscriptGh(transcription, openaiClient, model) {
  const words = transcription.trim().split(/\s+/).length;
  if (words <= WORDS_SHORT_GH) return { text: transcription, compressed: false, words };
  log.info(`Long call (${words} words) — compressing...`);
  const isDeep = words > WORDS_MEDIUM_GH;
  const prompt = isDeep
    ? "Extract VERBATIM excerpts for quality evaluation: 1.OPENING(60sec) 2.PITCH MOMENTS 3.OBJECTION HANDLING 4.TONE/ENERGY shifts 5.PROFANITY(exact words) 6.CLOSING(60sec) 7.RED FLAGS. Total 400-600 words. Exact quotes only."
    : "Extract verbatim: 1.OPENING(45sec) 2.KEY STATEMENTS 3.OBJECTION HANDLING 4.PROFANITY 5.CLOSING. 300-500 words. Exact quotes only.";
  try {
    const resp = await openaiClient.chat.completions.create({
      model, messages: [
        { role: "system", content: prompt },
        { role: "user",   content: `Transcript (${words} words):\n---\n${transcription}\n---` }
      ], max_completion_tokens: 1200
    });
    const compressed = resp.choices[0]?.message?.content || transcription.slice(0, 8000);
    log.info(`Compressed: ${words} → ${compressed.trim().split(/\s+/).length} words`);
    return { text: compressed, compressed: true, words };
  } catch (err) {
    log.warn(`Compression failed: ${err.message}`);
    return { text: transcription.slice(0, 8000), compressed: true, words };
  }
}

async function analyzeCall(transcription, meta = {}) {
  const CC = `
====================================================================
AMERICAN FREIGHT WAY / DRENIX — RECRUITER CALL STANDARDS
====================================================================
CONTEXT: Trucking recruiter calls to owner-operators (CDL-A drivers).
Carrier: American Freight Way / Bipolar Bear Enterprises, Hattiesburg MS.
MC #1257747 | USDOT #3650011. Evaluate the RECRUITER only.

━━━ ABSOLUTE PROHIBITIONS (ZERO TOLERANCE) ━━━

❌ LANGUAGE: Profanity, offensive/crude/sexual/discriminatory language
❌ CONDUCT: Rude or dismissive to driver or their family — EVER
❌ CONDUCT: Arguing, raising voice, matching hostile energy
❌ CONDUCT: Getting defensive or taking rejection personally
❌ CONDUCT: Badmouthing competitor carriers by name
❌ CONDUCT: Making promises that cannot be kept
❌ CONDUCT: Talking over the driver or interrupting repeatedly
❌ PERFORMANCE: Sounding tired, bored, cold, or disinterested
❌ PERFORMANCE: Calling without a clear purpose
❌ PERFORMANCE: Leaving a call without confirming a next step

━━━ REQUIRED CONDUCT ━━━

✅ Polite, respectful, professional on EVERY call — even if driver says no
✅ Treat drivers as BUSINESS OWNERS, not applicants
✅ Emotionally bulletproof — rejection is normal, not personal
✅ Greet by last name (Mr. [Last Name]) — shows respect
✅ CONVERSATION ENERGY MATH (mandatory):
   Recruiter DOWN + Driver DOWN = NO conversion
   Recruiter DOWN + Driver UP = NO trust
   Recruiter UP + Driver DOWN = NO confidence
   Recruiter UP + Driver UP = CONVERSION ✅
   → Recruiter MUST bring positive energy regardless of driver's mood

━━━ LISTENING REQUIREMENTS ━━━
✅ Listen MORE than you talk — active listening is a core skill
✅ Respond to what driver actually says, not just the next pitch point
✅ Driver's pain tells you how to pitch — listen for it
✅ When they open up emotionally, you win — emotion = leverage
✅ Use silence after asking about current rates or frustrations

━━━ HOSTILE DRIVER PROTOCOL ━━━
If driver curses, yells, or says "Stop calling me!":
→ "No problem at all, I'll take you off our list. Have a great day." [hang up]
→ NEVER argue or match energy. Never delete driver who owns a truck.

━━━ OBJECTION STANDARDS ━━━
"Not interested"         → Acknowledge calmly, ask why, leave warm door open
"Happy with carrier"     → Respect it: "If your dispatcher drops the ball, call me first"
"Talk to my wife"        → Validate: "Smart. Have her call me with questions."
"Been scammed before"    → Offer FMCSA SAFER verification (MC #1257747)
"Fee too high"           → Pivot to NET earnings: "Our drivers gross $2K more/week"
"Want to keep my MC"     → Educate on lease vs own MC — respectfully

━━━ VOCAL STANDARDS ━━━
✅ Confident, resonant, varied pitch — NOT monotone
✅ Clear articulation, appropriate pace, audible smile
✅ "Your tone sells more than your script"
❌ Uptalking (statements as questions?), monotone, weak/breathy voice
❌ Filler words: "um," "uh," "ah," "so," "kind of," "you know"
❌ Rushing (sounds scripted), mumbling

━━━ LANGUAGE STYLE ━━━
✅ Speak like a dispatcher or trucking buddy, NOT a corporate call center rep
✅ Acceptable rapport: "Brother," "Bossman," "Partner," "Driver"
✅ OUTCOME language — never just features:
   ❌ "We have 24/7 dispatch" → ✅ "You'll never wait on a dispatcher at midnight again"
   ❌ "Pre-booked loads" → ✅ "You stay loaded and rolling — no chasing freight on load boards"
   ❌ "Weekly pay" → ✅ "You know exactly what hits your account every Friday"

━━━ FIRST CONTACT CALL STRUCTURE (2–4 minutes) ━━━
1. OPENER — name, company, get to the point fast with authority
2. QUALIFYING: own truck or lease? solo/team? own trailer or power-only?
   current gross? biggest frustration? ready to move when? clear MVR/Clearinghouse?
3. PITCH — 30 seconds, outcome-focused, based on what driver said
4. OBJECTION HANDLING — smooth, never defensive
5. CLOSE — always ask for next step, never leave call open-ended

━━━ INDUSTRY KNOWLEDGE (must demonstrate) ━━━
Gross vs Net, RPM, fuel/IFTA/tolls, deadhead, Amazon vs brokered freight,
Dry Van vs Power Only, ELD compliance, insurance types (Liability/Cargo/NTL/
Bobtail/Physical Damage), escrow, DOT inspection seasons.
"If driver asks about freight type and recruiter says I'm not sure — deal is at risk"

━━━ TRANSPARENCY ━━━
✅ Show every deduction upfront — never hide fees
✅ Offer FMCSA SAFER verification
✅ "Recruit drivers like investors — because they ARE investing their truck"

━━━ FOLLOW-UP DISCIPLINE ━━━
✅ 80% of sales happen after the 5th contact — follow up relentlessly but respectfully
✅ Drop new lane updates or better loads to re-engage cold leads
✅ Reconnect after holidays, fuel price changes, DOT blitz weeks
✅ Always have a reason when you call back
`;
  const FC = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CALL TYPE DETECTION & CRITERIA — READ BEFORE EVALUATING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Identify the call type FIRST, then apply correct criteria.
Score ONLY against the criteria for the detected call type.

─────────────────────────────────────────────
TYPE 1: first_contact — Cold Call
─────────────────────────────────────────────
Signs: Recruiter introduces company for first time. Driver doesn't know recruiter.
Recruiter asks basic qualification questions (own truck? what are you grossing?).
Apply: Full FIRST CONTACT CALL STRUCTURE above. Score on qualifying, pitch, close.

─────────────────────────────────────────────
TYPE 2: warm_outreach — Re-engaging with New Value
─────────────────────────────────────────────
Signs: Had contact before. Driver went cold or ghosted. Recruiter returns with
NEW specific value: new lane, rate increase, driver success story, market change.
Phrases: "I've got something new," "rates went up on your lane," "just had a driver
start that run $500 more/week," "after the DOT blitz season," "wanted to reach back."
✅ REQUIRED: Specific new value (not just "checking in"), brief 1-2 min, warm not desperate,
   one qualifying question, clear but low-pressure next step.
❌ NEVER: Sound desperate, guilt-trip ("I've been trying to reach you"), re-pitch everything.

─────────────────────────────────────────────
TYPE 3: objection_followup — Returning to Address Specific Objection
─────────────────────────────────────────────
Signs: Driver had specific objection last call (needs to talk to wife, needs to
think, comparing carriers, bad experience before). Recruiter calls back with answer.
Phrases: "last time you mentioned," "you said you wanted to talk to your wife,"
"I looked into what you asked about," "I have an answer to your question about..."
✅ REQUIRED: Reference the SPECIFIC objection, bring direct answer/resolution,
   stay focused (don't re-pitch everything), confirm if situation has changed, next step.
❌ NEVER: Forget what was said, pressure without addressing the real objection.

─────────────────────────────────────────────
TYPE 4: document_collection — Gathering Paperwork
─────────────────────────────────────────────
Signs: Collecting CDL, medical card, annual inspection, clearinghouse consent,
MVR authorization, W9, voided check, 2290, IRP plates, ELD info, proof of insurance.
✅ REQUIRED: State purpose immediately. Specific about exactly what is needed.
   Explain WHY each doc is needed. Set clear deadline ("text a photo today by 3 PM CT").
   Offer to help if stuck. Confirm what was received vs what is still missing.
   Give timeline: "Once we have everything, Safety reviews in 24-48 hours."
❌ NEVER: Vague about what's needed, pressure without explanation, ask for same doc twice.

─────────────────────────────────────────────
TYPE 5: status_check — Following Up on Pending Items
─────────────────────────────────────────────
Signs: Checking status of MVR, drug test, clearinghouse, insurance quote,
safety pre-approval, background check, contract sent/awaiting signature.
✅ REQUIRED: State exactly what you're checking and why. Have the status ready
   before calling if possible. Give specific timeline if still pending.
   Be transparent if there's a problem. Keep it brief (60-90 sec if no issues).
❌ NEVER: Call to say "I don't know yet," be vague about timelines, hide problems.

─────────────────────────────────────────────
TYPE 6: onboarding — Setting Up Approved Driver
─────────────────────────────────────────────
Signs: Driver is approved and setting up for first load. Topics: orientation
scheduling, ELD device setup, fuel card, first dispatch, 2290, IRP plates,
settlement/direct deposit setup, truck inspection reminder.
✅ REQUIRED: Organized and know where driver is in checklist. Walk through each
   step clearly and patiently. Explain each step and what happens after.
   Express genuine excitement ("You're almost ready to roll!"). Verify driver
   has everything (ELD, fuel card, first load details, settlement info).
❌ NEVER: Rush driver through setup, assume they know what to do, skip steps.

─────────────────────────────────────────────
TYPE 7: active_checkin — Driver is Running
─────────────────────────────────────────────
Signs: Driver is actively hauling loads. Topics: how first week went, settlement
accuracy, load availability/volume, dispatch responsiveness, equipment issues,
compliance reminders (annual inspection due, DOT blitz prep, ELD renewal, 2290).
✅ REQUIRED: Specific questions, not generic ("Did your Friday settlement look
   right?" not "How's everything?"). Acknowledge driver's effort. Listen to
   complaints seriously and escalate if needed. Have answers ready. Solution-oriented.
   Compliance reminders should be helpful, not threatening.
❌ NEVER: Generic check-in with no substance, dismiss complaints, call without reason.

─────────────────────────────────────────────
TYPE 8: retention — Driver Unhappy or At Risk of Leaving
─────────────────────────────────────────────
Signs: Driver has complained, mentioned leaving, comparing other carriers,
or went quiet. This is a SAVE call — treat it as highest priority.
✅ REQUIRED: Acknowledge the problem FIRST before defending anything.
   Validate driver's feelings. Concrete solution with specific timeline.
   Only commit to what you can actually control. End with clear action plan:
   "Here's exactly what I'm doing and by when."
❌ NEVER: Defensive, dismiss complaint as overreaction, make empty promises,
   re-pitch the carrier like it's a new call, get emotional.

─────────────────────────────────────────────
TYPE 9: nurture — Low-Pressure Check-in for Parked Leads
─────────────────────────────────────────────
Signs: Driver previously said "not yet," "maybe next month," "waiting on my
trailer." Recruiter staying on radar without pressure. 60-90 seconds max.
✅ REQUIRED: Brief. Reference when last spoke and what changed since.
   Bring ONE relevant update (rate change, new lane, driver success story).
   Zero pressure: "Just wanted to stay on your radar. When you're ready, I'm here."
   Offer to follow up in 30 days if still not ready.
❌ NEVER: Long call, pressure, re-pitch entire offer, sound impatient with timeline.

─────────────────────────────────────────────
UNIVERSAL RULES (ALL call types)
─────────────────────────────────────────────
✅ Always: Professional tone, no profanity, positive energy, listen actively, thank driver
✅ Always: Clear next step at end of every call — no exceptions

AUTOMATIC SCORE PENALTIES (all types):
❌ Profanity/offensive language   → score cannot exceed 50
❌ Rude to driver or family       → score cannot exceed 60
❌ Argumentative / defensive      → -20 points
❌ Matched hostile energy         → -20 points
❌ Monotone/dead energy throughout → -15 points
❌ No clear purpose for call      → -15 points
❌ No next step at end            → -10 points

SCORING RANGES (apply to all types):
90-100: Excellent — appropriate for call type, listened, purposeful, clear next step
75-89:  Good — mostly professional, minor issues
60-74:  Fair — wrong approach for call type, unclear purpose, or weak close
40-59:  Poor — wrong call type approach, weak energy, no close, or conduct issues
0-39:   Unacceptable — profanity, rudeness, aggression, or serious misconduct
`;

  const { text: prepared, compressed, words } = await compressTranscriptGh(
    transcription, openai, config.openai.analysisModel
  );

  const SYSTEM = [
    "You are a professional call quality analyst for American Freight Way / DRENIX.",
    "Evaluate recruiter calls against the company official HR training standards.",
    "", CC, "", FC, "",
    "DETECT CALL TYPE: first_contact | warm_outreach | objection_followup |",
    "document_collection | status_check | onboarding | active_checkin | retention | nurture",
    "",
    "APPLY correct criteria for detected type. Do NOT penalize pipeline calls for not",
    "pitching. Do NOT evaluate warm outreach as first contact.",
    "",
    "Respond ONLY with valid JSON, no markdown:",
    '{"call_type":"<type>","call_type_label":"<label>","score":<0-100>,',
    '"profanity_detected":<bool>,"profanity_words":[],',
    '"manners_rating":"<E|G|F|P>","communication_rating":"<E|G|F|P>",',
    '"tone_rating":"<E|G|F|P>","listening_rating":"<E|G|F|P>","energy_rating":"<E|G|F|P>",',
    '"call_purpose_clear":<bool>,"next_step_given":<bool>,',
    '"behavior_summary":"<2-3 sentences>","strengths":"<specific>","weaknesses":"<specific>",',
    '"criteria_violations":[],"advice":"<actionable>","short_review":"<1-2 sentences>"}']
    .join("\n");

  const note = compressed ? `[Long call ~${Math.round(words/130)}min — excerpts extracted]` : "";
  const USER = [`Direction: ${meta.direction||"?"} | Duration: ${meta.durationSeconds||0}s`,
    note, "", "Transcript:", "---", prepared, "---", "Detect call type, then evaluate."
  ].filter(Boolean).join("\n");

  try {
    const resp = await openai.chat.completions.create({
      model: config.openai.analysisModel,
      messages: [{ role:"system", content:SYSTEM }, { role:"user", content:USER }], max_completion_tokens: 1500
    });
    const raw = resp.choices[0]?.message?.content || "{}";
    try { return JSON.parse(raw.replace(/```json|```/g,"").trim()); }
    catch { return ghFallback(`JSON parse error`); }
  } catch (err) {
    log.error(`analyzeCall: ${err.message}`);
    return ghFallback(err.message);
  }
}

function ghFallback(reason) {
  return { call_type:"first_contact", call_type_label:"Unknown — Manual Review",
    score:0, profanity_detected:false, profanity_words:[],
    manners_rating:"Fair", communication_rating:"Fair", tone_rating:"Fair",
    listening_rating:"Fair", energy_rating:"Fair", call_purpose_clear:false,
    next_step_given:false, behavior_summary:`Analysis error: ${reason}. Manual review needed.`,
    strengths:"N/A", weaknesses:"Manual review required",
    criteria_violations:[], advice:"Review manually.", short_review:"Analysis failed."
  };
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
    ], max_completion_tokens: 1200
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
    ], max_completion_tokens: 1800
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
  getRcToken, fetchCallLogs, downloadRecording, parseRecord,
  transcribeAudio, analyzeCall,
  generateDailySummary, generateWeeklySummary,
  syncAndAnalyzeCalls, analyzeSilently,
  scoreEmoji, safeJson
};
