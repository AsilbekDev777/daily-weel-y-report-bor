'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../utils/config');
const logger = require('../utils/logger');
const db = require('../db/database');
const rc = require('./ringcentral');
const ai = require('./openai');
const timeUtils = require('../utils/time');
const { formatCallReview, splitMessage } = require('../utils/formatter');

/**
 * Main polling job: runs every POLL_CRON
 * For each registered user: fetch new calls, download, transcribe, analyze, notify
 */
async function runPollJob(bot) {
  logger.info('=== Poll job started ===');
  const users = db.getAllActiveUsers();
  logger.info(`Found ${users.length} active user(s)`);

  for (const user of users) {
    try {
      await processUserCalls(user, bot);
    } catch (err) {
      logger.error(`Poll job error for user ${user.telegram_id}: ${err.message}`);
    }
    // Delay between users to respect rate limits
    await ai.sleep(2000);
  }

  logger.info('=== Poll job finished ===');
}

/**
 * Process calls for a single user
 */
async function processUserCalls(user, bot) {
  const telegramId = user.telegram_id;
  const lookbackMinutes = config.bot.lookbackMinutes;

  logger.info(`Processing user ${telegramId} (ext: ${user.rc_extension_id})`);

  // Step 1: Fetch recent calls from RingCentral
  const { dateFrom, dateTo } = timeUtils.lookbackRange(lookbackMinutes);

  let rawCalls;
  try {
    rawCalls = await rc.fetchCallLogs(dateFrom, dateTo, user.rc_extension_id);
  } catch (err) {
    logger.error(`fetchCallLogs failed for ${telegramId}: ${err.message}`);
    return;
  }

  // Step 2: Filter and store new calls
  let newCallsCount = 0;
  for (const record of rawCalls) {
    const duration = record.duration || 0;
    if (duration < config.bot.minCallDurationSeconds) continue;
    if (!record.recording || !record.recording.contentUri) continue;

    if (!db.callExists(record.id)) {
      const parsed = rc.parseCallRecord(record, telegramId, user.rc_extension_id);
      db.insertCall(parsed);
      newCallsCount++;
    }
  }

  logger.info(`User ${telegramId}: ${newCallsCount} new calls stored`);

  // Step 3: Analyze unprocessed calls (limit per sync)
  const toAnalyze = db.getUnanalyzedCallsWithRecording(telegramId, config.bot.maxAnalyzePerSync);
  logger.info(`User ${telegramId}: ${toAnalyze.length} calls queued for analysis`);

  for (const call of toAnalyze) {
    try {
      await analyzeAndNotify(call, user, bot);
      await ai.sleep(config.openai.delayMs);
    } catch (err) {
      logger.error(`analyzeAndNotify failed for call ${call.rc_call_id}: ${err.message}`);
    }
  }

  // Update sync time
  db.setLastSyncedAt(telegramId, new Date().toISOString());
}

/**
 * Download, transcribe, analyze a call and send result to user
 */
async function analyzeAndNotify(call, user, bot) {
  const telegramId = user.telegram_id;
  logger.info(`Analyzing call ${call.rc_call_id} for user ${telegramId}`);

  // Download recording
  let localFile = call.local_file;
  if (!localFile || !fs.existsSync(localFile)) {
    localFile = await rc.downloadRecording(call.rc_call_id, call.recording_url);
    if (!localFile) {
      logger.warn(`Could not download recording for ${call.rc_call_id}, skipping`);
      return;
    }
    db.updateCallLocalFile(call.rc_call_id, localFile);
  }

  // Transcribe
  let transcription;
  try {
    transcription = await ai.transcribeAudio(localFile);
  } catch (err) {
    logger.error(`Transcription failed for ${call.rc_call_id}: ${err.message}`);
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
    logger.error(`Analysis failed for ${call.rc_call_id}: ${err.message}`);
    return;
  }

  // Save to DB
  db.updateCallAnalysis(call.rc_call_id, transcription, analysis, analysis.score);

  // Delete local file to save space
  try {
    if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
  } catch (e) {
    logger.warn(`Could not delete file ${localFile}: ${e.message}`);
  }

  // Send notification to user
  try {
    const callWithDuration = {
      ...call,
      durationSeconds: call.duration_seconds,
      start_time: call.start_time
    };
    const message = formatCallReview(callWithDuration, analysis);
    const chunks = splitMessage(message);
    for (const chunk of chunks) {
      await bot.telegram.sendMessage(telegramId, chunk, { parse_mode: 'Markdown' });
      await ai.sleep(500);
    }
    logger.info(`Sent call review to ${telegramId} (score: ${analysis.score})`);
  } catch (err) {
    logger.error(`Failed to send review to ${telegramId}: ${err.message}`);
  }
}

/**
 * End-of-shift job: generate and send daily summary
 */
async function runEndOfShiftJob(bot) {
  logger.info('=== End-of-shift job started ===');
  const users = db.getAllActiveUsers();
  const today = timeUtils.todayDateCT();

  for (const user of users) {
    const telegramId = user.telegram_id;
    try {
      // Skip if already sent today
      if (db.dailyReviewExists(telegramId, today)) {
        logger.info(`Daily review already sent to ${telegramId} for ${today}`);
        continue;
      }

      const calls = db.getCallsForDate(telegramId, today);
      if (calls.length === 0) {
        logger.info(`No analyzed calls for ${telegramId} on ${today}`);
        await bot.telegram.sendMessage(
          telegramId,
          `📋 *End of Shift – ${today}*\n\nNo calls were analyzed today. Either no calls were made, or recordings were not available.`,
          { parse_mode: 'Markdown' }
        );
        db.saveDailyReview(telegramId, today, 'No calls analyzed.', null, 0, 0);
        continue;
      }

      // Prepare enriched reviews
      const enriched = calls.map(c => ({
        ...c,
        durationSeconds: c.duration_seconds,
        analysis: safeParseJson(c.analysis_json)
      }));

      // Generate summary
      const result = await ai.generateDailySummary(enriched, today);

      // Save to DB
      const avgScore = result.overallScore;
      db.saveDailyReview(telegramId, today, result.summary, avgScore, calls.length, calls.length);

      // Send to user
      const header = `🏁 *End of Shift Report – ${today}*\n📞 Calls Analyzed: ${calls.length}${avgScore !== null ? `\n⭐ Average Score: *${avgScore}/100*` : ''}\n\n`;
      const fullMessage = header + result.summary;
      const chunks = splitMessage(fullMessage);
      for (const chunk of chunks) {
        await bot.telegram.sendMessage(telegramId, chunk, { parse_mode: 'Markdown' });
        await ai.sleep(500);
      }

      logger.info(`Daily report sent to ${telegramId} for ${today}`);
    } catch (err) {
      logger.error(`End-of-shift job error for ${telegramId}: ${err.message}`);
    }

    await ai.sleep(3000);
  }

  logger.info('=== End-of-shift job finished ===');
}

/**
 * Weekly summary job: runs after Saturday end-of-shift
 */
async function runWeeklyJob(bot) {
  logger.info('=== Weekly job started ===');
  const users = db.getAllActiveUsers();
  const { weekStart, weekEnd } = timeUtils.lastWeekWorkingRange();

  for (const user of users) {
    const telegramId = user.telegram_id;
    try {
      const dailyReviews = db.getDailyReviews(telegramId, weekStart, weekEnd);
      if (dailyReviews.length === 0) {
        logger.info(`No daily reviews for ${telegramId} in week ${weekStart}–${weekEnd}`);
        continue;
      }

      const result = await ai.generateWeeklySummary(dailyReviews, weekStart, weekEnd);
      const avgScore = result.overallScore;

      // Save
      db.saveWeeklyReview(
        telegramId, weekStart, weekEnd,
        result.summary, avgScore,
        dailyReviews.reduce((s, r) => s + (r.total_calls || 0), 0)
      );

      // Send
      const header = `📅 *Weekly Performance Report*\n🗓 ${weekStart} → ${weekEnd}\n📆 Days Reviewed: ${dailyReviews.length}${avgScore !== null ? `\n🏆 Weekly Average: *${avgScore}/100*` : ''}\n\n`;
      const fullMessage = header + result.summary;
      const chunks = splitMessage(fullMessage);
      for (const chunk of chunks) {
        await bot.telegram.sendMessage(telegramId, chunk, { parse_mode: 'Markdown' });
        await ai.sleep(500);
      }

      logger.info(`Weekly report sent to ${telegramId} for week ${weekStart}`);
    } catch (err) {
      logger.error(`Weekly job error for ${telegramId}: ${err.message}`);
    }

    await ai.sleep(3000);
  }

  logger.info('=== Weekly job finished ===');
}

/**
 * Backfill: process calls from the last N days on first registration
 */
async function backfillUser(user, bot, days = null) {
  const backfillDays = days || config.bot.backfillDays;
  const { dateFrom, dateTo } = timeUtils.lastNDaysRange(backfillDays);

  logger.info(`Backfill for user ${user.telegram_id}: last ${backfillDays} days`);

  let rawCalls;
  try {
    rawCalls = await rc.fetchCallLogs(dateFrom, dateTo, user.rc_extension_id);
  } catch (err) {
    logger.error(`Backfill fetchCallLogs failed: ${err.message}`);
    return;
  }

  let stored = 0;
  for (const record of rawCalls) {
    if ((record.duration || 0) < config.bot.minCallDurationSeconds) continue;
    if (!record.recording || !record.recording.contentUri) continue;
    if (!db.callExists(record.id)) {
      const parsed = rc.parseCallRecord(record, user.telegram_id, user.rc_extension_id);
      db.insertCall(parsed);
      stored++;
    }
  }

  logger.info(`Backfill: stored ${stored} calls for ${user.telegram_id}`);
  return stored;
}

function safeParseJson(str) {
  try {
    return str ? JSON.parse(str) : {};
  } catch {
    return {};
  }
}

module.exports = {
  runPollJob,
  runEndOfShiftJob,
  runWeeklyJob,
  backfillUser,
  processUserCalls
};
