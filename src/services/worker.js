'use strict';

const fs = require('fs');
const config = require('../utils/config');
const logger = require('../utils/logger');
const db = require('../db/database');
const rc = require('./ringcentral');
const ai = require('./openai');
const timeUtils = require('../utils/time');
const { splitMessage } = require('../utils/formatter');

// ─── Poll job ─────────────────────────────────────────────────────────────────

async function runPollJob(bot) {
  logger.info('=== Poll job started ===');
  const users = db.getAllActiveUsers();
  logger.info(`Found ${users.length} active user(s)`);

  for (const user of users) {
    try {
      await processUserCalls(user);
    } catch (err) {
      logger.error(`Poll job error for user ${user.telegram_id}: ${err.message}`);
    }
    await ai.sleep(2000);
  }

  logger.info('=== Poll job finished ===');
}

async function processUserCalls(user) {
  const telegramId = user.telegram_id;
  logger.info(`Processing user ${telegramId} (ext: ${user.rc_extension_id || 'account'})`);

  // Fetch recent calls
  const { dateFrom, dateTo } = timeUtils.lookbackRange(config.bot.lookbackMinutes);
  let rawCalls;
  try {
    rawCalls = await rc.fetchCallLogs(dateFrom, dateTo, user.rc_extension_id);
  } catch (err) {
    logger.error(`fetchCallLogs failed for ${telegramId}: ${err.message}`);
    return;
  }

  // Store new calls (no notification yet — silent)
  let newCount = 0;
  for (const record of rawCalls) {
    if ((record.duration || 0) < config.bot.minCallDurationSeconds) continue;
    if (!record.recording?.contentUri) continue;
    if (!db.callExists(record.id)) {
      db.insertCall(rc.parseCallRecord(record, telegramId, user.rc_extension_id));
      newCount++;
    }
  }
  logger.info(`User ${telegramId}: ${newCount} new calls stored`);

  // Silently transcribe + analyze calls (no Telegram message sent here)
  const toAnalyze = db.getUnanalyzedCallsWithRecording(telegramId, config.bot.maxAnalyzePerSync);
  logger.info(`User ${telegramId}: ${toAnalyze.length} calls queued for analysis`);

  for (const call of toAnalyze) {
    try {
      await analyzeCall(call);
      await ai.sleep(config.openai.delayMs);
    } catch (err) {
      logger.error(`analyzeCall failed for ${call.rc_call_id}: ${err.message}`);
    }
  }

  db.setLastSyncedAt(telegramId, new Date().toISOString());
}

/**
 * Download → transcribe → analyze a call and save to DB.
 * Does NOT send anything to Telegram — results accumulate for end-of-shift report.
 */
async function analyzeCall(call) {
  logger.info(`Analyzing call ${call.rc_call_id} silently...`);

  // Download
  let localFile = call.local_file;
  if (!localFile || !fs.existsSync(localFile)) {
    localFile = await rc.downloadRecording(call.rc_call_id, call.recording_url);
    if (!localFile) {
      logger.warn(`Could not download ${call.rc_call_id}, skipping`);
      return;
    }
    db.updateCallLocalFile(call.rc_call_id, localFile);
  }

  // Transcribe
  let transcription;
  try {
    transcription = await ai.transcribeAudio(localFile);
  } catch (err) {
    logger.error(`Transcription failed ${call.rc_call_id}: ${err.message}`);
    return;
  }
  if (!transcription || transcription.trim().length < 10) {
    logger.warn(`Transcription too short for ${call.rc_call_id}, skipping`);
    return;
  }

  // Analyze
  let analysis;
  try {
    analysis = await ai.analyzeCall(transcription, {
      direction: call.direction,
      durationSeconds: call.duration_seconds,
      startTime: call.start_time
    });
  } catch (err) {
    logger.error(`Analysis failed ${call.rc_call_id}: ${err.message}`);
    return;
  }

  // Save to DB — no Telegram message
  db.updateCallAnalysis(call.rc_call_id, transcription, analysis, analysis.score);
  logger.info(`Call ${call.rc_call_id} analyzed silently (score: ${analysis.score})`);

  // Clean up audio file
  try {
    if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
  } catch (e) {
    logger.warn(`Could not delete ${localFile}: ${e.message}`);
  }
}

// ─── End-of-shift report ──────────────────────────────────────────────────────

async function runEndOfShiftJob(bot) {
  logger.info('=== End-of-shift job started ===');
  const users = db.getAllActiveUsers();
  const today = timeUtils.todayDateCT();

  for (const user of users) {
    const telegramId = user.telegram_id;
    try {
      if (db.dailyReviewExists(telegramId, today)) {
        logger.info(`Daily review already sent to ${telegramId} for ${today}`);
        continue;
      }

      const calls = db.getCallsForDate(telegramId, today);
      logger.info(`User ${telegramId}: ${calls.length} analyzed calls on ${today}`);

      if (calls.length === 0) {
        const msg =
          `📋 *End of Shift – ${today}*\n\n` +
          `No calls were analyzed today.\n` +
          `Either no calls were made, recordings were unavailable, ` +
          `or calls were shorter than ${config.bot.minCallDurationSeconds}s.`;
        await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'Markdown' });
        db.saveDailyReview(telegramId, today, 'No calls analyzed.', null, 0, 0);
        continue;
      }

      const enriched = calls.map(c => ({
        ...c,
        durationSeconds: c.duration_seconds,
        analysis: safeJson(c.analysis_json)
      }));

      const result = await ai.generateDailySummary(enriched, today);
      const avgScore = result.overallScore;

      db.saveDailyReview(telegramId, today, result.summary, avgScore, calls.length, calls.length);

      const header =
        `🏁 *End of Shift Report – ${today}*\n` +
        `📞 Calls Analyzed: *${calls.length}*\n` +
        (avgScore !== null ? `⭐ Average Score: *${avgScore}/100* ${scoreEmoji(avgScore)}\n` : '') +
        `\n`;

      const fullMessage = header + result.summary;
      for (const chunk of splitMessage(fullMessage)) {
        await bot.telegram.sendMessage(telegramId, chunk, { parse_mode: 'Markdown' });
        await ai.sleep(400);
      }

      logger.info(`Daily report sent to ${telegramId} (${calls.length} calls, avg: ${avgScore})`);

      // ── Cleanup: delete today's calls after report is sent ─────────────────
      // Ensures tomorrow's report contains only tomorrow's calls.
      // daily_reviews table is preserved for the weekly report.
      try {
        const deleted = db.deleteCallsForDate(telegramId, today);
        logger.info(`🧹 Cleanup: removed ${deleted} call records for ${today}`);
        const old = db.deleteCallsOlderThan(2);
        if (old > 0) logger.info(`🧹 Cleanup: removed ${old} stale calls older than 2 days`);
      } catch (cleanErr) {
        logger.warn(`Cleanup error: ${cleanErr.message}`);
      }
    } catch (err) {
      logger.error(`End-of-shift error for ${telegramId}: ${err.message}`);
    }

    await ai.sleep(3000);
  }

  logger.info('=== End-of-shift job finished ===');
}

// ─── Weekly report ────────────────────────────────────────────────────────────

async function runWeeklyJob(bot) {
  logger.info('=== Weekly job started ===');
  const users = db.getAllActiveUsers();
  const { weekStart, weekEnd } = timeUtils.lastWeekWorkingRange();

  for (const user of users) {
    const telegramId = user.telegram_id;
    try {
      const dailyReviews = db.getDailyReviews(telegramId, weekStart, weekEnd);
      if (dailyReviews.length === 0) {
        logger.info(`No daily reviews for ${telegramId} week ${weekStart}–${weekEnd}`);
        continue;
      }

      const result = await ai.generateWeeklySummary(dailyReviews, weekStart, weekEnd);
      const avgScore = result.overallScore;
      const totalCalls = dailyReviews.reduce((s, r) => s + (r.total_calls || 0), 0);

      db.saveWeeklyReview(telegramId, weekStart, weekEnd, result.summary, avgScore, totalCalls);

      const header =
        `📅 *Weekly Performance Report*\n` +
        `🗓 ${weekStart} → ${weekEnd}\n` +
        `📆 Days Reviewed: *${dailyReviews.length}*\n` +
        `📞 Total Calls: *${totalCalls}*\n` +
        (avgScore !== null ? `🏆 Weekly Average: *${avgScore}/100* ${scoreEmoji(avgScore)}\n` : '') +
        `\n`;

      const fullMessage = header + result.summary;
      for (const chunk of splitMessage(fullMessage)) {
        await bot.telegram.sendMessage(telegramId, chunk, { parse_mode: 'Markdown' });
        await ai.sleep(400);
      }

      logger.info(`Weekly report sent to ${telegramId} for ${weekStart}`);
    } catch (err) {
      logger.error(`Weekly job error for ${telegramId}: ${err.message}`);
    }

    await ai.sleep(3000);
  }

  logger.info('=== Weekly job finished ===');
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

async function backfillUser(user, bot, days = null) {
  const backfillDays = days || config.bot.backfillDays;
  const { dateFrom, dateTo } = timeUtils.lastNDaysRange(backfillDays);
  logger.info(`Backfill for ${user.telegram_id}: last ${backfillDays} days`);

  let rawCalls;
  try {
    rawCalls = await rc.fetchCallLogs(dateFrom, dateTo, user.rc_extension_id);
  } catch (err) {
    logger.error(`Backfill fetchCallLogs failed: ${err.message}`);
    return 0;
  }

  let stored = 0;
  for (const record of rawCalls) {
    if ((record.duration || 0) < config.bot.minCallDurationSeconds) continue;
    if (!record.recording?.contentUri) continue;
    if (!db.callExists(record.id)) {
      db.insertCall(rc.parseCallRecord(record, user.telegram_id, user.rc_extension_id));
      stored++;
    }
  }

  logger.info(`Backfill: stored ${stored} calls for ${user.telegram_id}`);
  return stored;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeJson(str) {
  try { return str ? JSON.parse(str) : {}; } catch { return {}; }
}

function scoreEmoji(s) {
  if (s >= 90) return '🌟'; if (s >= 75) return '✅';
  if (s >= 60) return '🟡'; if (s >= 40) return '🟠'; return '🔴';
}

module.exports = {
  runPollJob,
  runEndOfShiftJob,
  runWeeklyJob,
  backfillUser,
  processUserCalls
};
