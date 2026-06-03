'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../utils/config');
const logger = require('../utils/logger');

let db;

function getDb() {
  if (!db) {
    const dbPath = path.resolve(config.bot.databasePath);
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    logger.info(`Database initialized at ${dbPath}`);
  }
  return db;
}

function initSchema() {
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
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
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
      UNIQUE(telegram_id, review_date),
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
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
      UNIQUE(telegram_id, week_start),
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      last_synced_at TEXT,
      FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
    );
  `);
}

// ─── Users ───────────────────────────────────────────────────────────────────

function upsertUser(telegramId, phoneNumber = null, extensionId = null) {
  const d = getDb();
  if (phoneNumber) {
    d.prepare(`
      INSERT INTO users (telegram_id, rc_phone_number, rc_extension_id)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        rc_phone_number = excluded.rc_phone_number,
        rc_extension_id = excluded.rc_extension_id,
        is_active = 1
    `).run(telegramId, phoneNumber, extensionId);
  } else {
    d.prepare(`
      INSERT INTO users (telegram_id)
      VALUES (?)
      ON CONFLICT(telegram_id) DO NOTHING
    `).run(telegramId);
  }
}

function getUser(telegramId) {
  return getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

function getAllActiveUsers() {
  return getDb().prepare('SELECT * FROM users WHERE is_active = 1 AND rc_phone_number IS NOT NULL').all();
}

// ─── Calls ───────────────────────────────────────────────────────────────────

function insertCall(call) {
  const d = getDb();
  try {
    d.prepare(`
      INSERT OR IGNORE INTO calls
        (rc_call_id, telegram_id, rc_extension_id, phone_number, direction, duration_seconds,
         start_time, end_time, recording_url, local_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      call.rcCallId,
      call.telegramId,
      call.extensionId || null,
      call.phoneNumber || null,
      call.direction || null,
      call.durationSeconds || 0,
      call.startTime || null,
      call.endTime || null,
      call.recordingUrl || null,
      call.localFile || null
    );
  } catch (e) {
    logger.error(`insertCall error: ${e.message}`);
  }
}

function callExists(rcCallId) {
  return !!getDb().prepare('SELECT id FROM calls WHERE rc_call_id = ?').get(rcCallId);
}

function getUnanalyzedCallsWithRecording(telegramId, limit = 4) {
  return getDb().prepare(`
    SELECT * FROM calls
    WHERE telegram_id = ? AND recording_url IS NOT NULL AND analyzed = 0
    ORDER BY start_time DESC
    LIMIT ?
  `).all(telegramId, limit);
}

function updateCallAnalysis(rcCallId, transcription, analysisJson, score) {
  getDb().prepare(`
    UPDATE calls SET
      transcription = ?,
      analysis_json = ?,
      score = ?,
      analyzed = 1
    WHERE rc_call_id = ?
  `).run(transcription, JSON.stringify(analysisJson), score, rcCallId);
}

function updateCallLocalFile(rcCallId, localFile) {
  getDb().prepare('UPDATE calls SET local_file = ? WHERE rc_call_id = ?').run(localFile, rcCallId);
}

function getCallsForDate(telegramId, dateStr) {
  // FIX: start_time is stored as UTC ISO string from RingCentral.
  // We must convert to CT before comparing the date, otherwise calls
  // in the evening (e.g. 18:50 CT = 23:50 UTC) fall on the "wrong" UTC date.
  // SQLite datetime() supports offset: UTC-5 (CDT) or UTC-6 (CST).
  // We use a wide range approach: query a 27-hour window covering the full CT day.
  const dayjs = require('dayjs');
  const utc = require('dayjs/plugin/utc');
  const tz  = require('dayjs/plugin/timezone');
  dayjs.extend(utc); dayjs.extend(tz);
  const startOfDay = dayjs.tz(dateStr + ' 00:00:00', 'America/Chicago').toISOString();
  const endOfDay   = dayjs.tz(dateStr + ' 23:59:59', 'America/Chicago').toISOString();
  return getDb().prepare(`
    SELECT * FROM calls
    WHERE telegram_id = ?
      AND start_time >= ?
      AND start_time <= ?
      AND analyzed = 1
    ORDER BY start_time ASC
  `).all(telegramId, startOfDay, endOfDay);
}

function getCallsForDateRange(telegramId, startDate, endDate) {
  const dayjs = require('dayjs');
  const utc = require('dayjs/plugin/utc');
  const tz  = require('dayjs/plugin/timezone');
  dayjs.extend(utc); dayjs.extend(tz);
  const from = dayjs.tz(startDate + ' 00:00:00', 'America/Chicago').toISOString();
  const to   = dayjs.tz(endDate   + ' 23:59:59', 'America/Chicago').toISOString();
  return getDb().prepare(`
    SELECT * FROM calls
    WHERE telegram_id = ?
      AND start_time >= ?
      AND start_time <= ?
      AND analyzed = 1
    ORDER BY start_time ASC
  `).all(telegramId, from, to);
}

// ─── Daily Reviews ────────────────────────────────────────────────────────────

function saveDailyReview(telegramId, reviewDate, reviewText, avgScore, totalCalls, analyzedCalls) {
  getDb().prepare(`
    INSERT INTO daily_reviews (telegram_id, review_date, review_text, avg_score, total_calls, analyzed_calls)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, review_date) DO UPDATE SET
      review_text = excluded.review_text,
      avg_score = excluded.avg_score,
      total_calls = excluded.total_calls,
      analyzed_calls = excluded.analyzed_calls
  `).run(telegramId, reviewDate, reviewText, avgScore, totalCalls, analyzedCalls);
}

function getDailyReviews(telegramId, fromDate, toDate) {
  return getDb().prepare(`
    SELECT * FROM daily_reviews
    WHERE telegram_id = ? AND review_date >= ? AND review_date <= ?
    ORDER BY review_date ASC
  `).all(telegramId, fromDate, toDate);
}

function dailyReviewExists(telegramId, reviewDate) {
  return !!getDb().prepare('SELECT id FROM daily_reviews WHERE telegram_id = ? AND review_date = ?').get(telegramId, reviewDate);
}

// ─── Weekly Reviews ───────────────────────────────────────────────────────────

function saveWeeklyReview(telegramId, weekStart, weekEnd, reviewText, avgScore, totalCalls) {
  getDb().prepare(`
    INSERT INTO weekly_reviews (telegram_id, week_start, week_end, review_text, avg_score, total_calls)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_id, week_start) DO UPDATE SET
      review_text = excluded.review_text,
      avg_score = excluded.avg_score,
      total_calls = excluded.total_calls
  `).run(telegramId, weekStart, weekEnd, reviewText, avgScore, totalCalls);
}

// ─── Sync State ───────────────────────────────────────────────────────────────

function getLastSyncedAt(telegramId) {
  const row = getDb().prepare('SELECT last_synced_at FROM sync_state WHERE telegram_id = ?').get(telegramId);
  return row ? row.last_synced_at : null;
}

function setLastSyncedAt(telegramId, isoString) {
  getDb().prepare(`
    INSERT INTO sync_state (telegram_id, last_synced_at)
    VALUES (?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET last_synced_at = excluded.last_synced_at
  `).run(telegramId, isoString);
}

/**
 * Delete all call records for a CT date after daily report is sent.
 * Keeps daily_reviews and weekly_reviews intact for weekly report.
 */
function deleteCallsForDate(telegramId, dateStr) {
  const dayjs = require('dayjs');
  const utc   = require('dayjs/plugin/utc');
  const tz    = require('dayjs/plugin/timezone');
  dayjs.extend(utc); dayjs.extend(tz);
  const startOfDay = dayjs.tz(dateStr + ' 00:00:00', 'America/Chicago').toISOString();
  const endOfDay   = dayjs.tz(dateStr + ' 23:59:59', 'America/Chicago').toISOString();
  const result = getDb().prepare(`
    DELETE FROM calls WHERE telegram_id = ? AND start_time >= ? AND start_time <= ?
  `).run(telegramId, startOfDay, endOfDay);
  return result.changes;
}

/**
 * Safety net: delete calls older than N days.
 */
function deleteCallsOlderThan(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const result = getDb().prepare(`DELETE FROM calls WHERE start_time < ?`).run(cutoff);
  return result.changes;
}

module.exports = {
  getDb,
  upsertUser,
  getUser,
  getAllActiveUsers,
  insertCall,
  callExists,
  getUnanalyzedCallsWithRecording,
  updateCallAnalysis,
  updateCallLocalFile,
  getCallsForDate,
  getCallsForDateRange,
  saveDailyReview,
  getDailyReviews,
  dailyReviewExists,
  saveWeeklyReview,
  getLastSyncedAt,
  setLastSyncedAt,
  deleteCallsForDate,
  deleteCallsOlderThan
};
