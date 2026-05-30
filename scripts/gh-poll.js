'use strict';

/**
 * gh-poll.js
 * Runs during shift hours every 30 min via GitHub Actions.
 * Fetches new calls, downloads recordings, transcribes + analyzes,
 * sends per-call reviews to Telegram.
 */

const fs = require('fs');
const {
  config, log, db, tgSend,
  isShiftActive, todayDateCT, lookbackRange, lastNDaysRange, sleep,
  fetchCallLogs, downloadRecording, parseRecord,
  transcribeAudio, analyzeCall,
  fmtCallReview
} = require('./gh-shared');

const isBackfill = process.argv.includes('--backfill');

async function main() {
  log.info(`=== gh-poll.js started [${isBackfill ? 'BACKFILL' : 'POLL'}] ===`);

  // In scheduled mode, skip if outside shift hours
  if (!isBackfill && process.env.GH_ACTIONS_MODE === 'true' && !isShiftActive()) {
    log.info('Outside shift hours (9 AM – 7 PM CT). Exiting.');
    process.exit(0);
  }

  const users = db.getAllActiveUsers();
  if (users.length === 0) {
    log.warn('No registered users found in DB. Have users started the bot and entered their phone number?');
    // Notify admins
    for (const adminId of config.bot.adminIds) {
      await tgSend(adminId,
        `⚠️ *GitHub Actions Poll*\n\nNo registered users found in the database.\n\nUsers need to start the Telegram bot and enter their phone number first.`
      );
    }
    process.exit(0);
  }

  log.info(`Processing ${users.length} user(s)`);

  for (const user of users) {
    try {
      await processUser(user);
    } catch (err) {
      log.error(`processUser ${user.telegram_id}: ${err.message}`);
      if (err.stack) log.error(err.stack);
    }
    await sleep(3000);
  }

  log.info('=== gh-poll.js finished ===');
}

async function processUser(user) {
  const { telegram_id: telegramId, rc_extension_id: extensionId } = user;
  log.info(`User ${telegramId} | ext: ${extensionId || 'account-level'}`);

  // Date range
  const range = isBackfill
    ? lastNDaysRange(config.bot.backfillDays)
    : lookbackRange(config.bot.lookbackMinutes);

  log.info(`Fetching calls ${range.dateFrom} → ${range.dateTo}`);

  // Fetch calls
  let rawCalls;
  try {
    rawCalls = await fetchCallLogs(range.dateFrom, range.dateTo, extensionId);
  } catch (err) {
    log.error(`fetchCallLogs failed: ${err.message}`);
    await tgSend(telegramId,
      `⚠️ *GitHub Actions*: Failed to fetch calls from RingCentral.\n\`${err.message}\``
    );
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

  // Analyze pending calls
  const limit = isBackfill ? 10 : config.bot.maxAnalyzePerSync;
  const toAnalyze = db.getUnanalyzed(telegramId, limit);
  log.info(`${toAnalyze.length} calls queued for analysis`);

  if (toAnalyze.length === 0) {
    if (isBackfill) {
      await tgSend(telegramId,
        `📭 *GitHub Actions Backfill*\n\nNo new recorded calls found in the last ${config.bot.backfillDays} days.\nI'll start capturing calls from now.`
      );
    }
    return;
  }

  if (isBackfill) {
    await tgSend(telegramId,
      `🔄 *GitHub Actions Backfill*\n\nFound *${toAnalyze.length}* recorded calls to analyze. Starting now...`
    );
  }

  for (const call of toAnalyze) {
    try {
      await analyzeAndNotify(call, telegramId);
    } catch (err) {
      log.error(`analyzeAndNotify ${call.rc_call_id}: ${err.message}`);
    }
    await sleep(config.openai.delayMs);
  }

  // Update sync state
  db.setLastSyncedAt(telegramId, new Date().toISOString());
}

async function analyzeAndNotify(call, telegramId) {
  log.info(`Analyzing call ${call.rc_call_id}...`);

  // Download recording
  let localFile = call.local_file;
  if (!localFile || !fs.existsSync(localFile)) {
    localFile = await downloadRecording(call.rc_call_id, call.recording_url);
    if (!localFile) {
      log.warn(`Could not download recording ${call.rc_call_id}, skipping`);
      return;
    }
    db.updateCallLocalFile(call.rc_call_id, localFile);
  }

  // Transcribe
  let transcription;
  try {
    transcription = await transcribeAudio(localFile);
  } catch (err) {
    log.error(`Transcription error: ${err.message}`);
    return;
  }

  if (!transcription || transcription.trim().length < 10) {
    log.warn(`Transcription too short for ${call.rc_call_id}, skipping`);
    return;
  }

  // Analyze
  let analysis;
  try {
    analysis = await analyzeCall(transcription, {
      direction: call.direction,
      durationSeconds: call.duration_seconds,
      startTime: call.start_time
    });
  } catch (err) {
    log.error(`Analysis error: ${err.message}`);
    return;
  }

  // Save to DB
  db.updateCallAnalysis(call.rc_call_id, transcription, analysis, analysis.score);

  // Clean up audio file
  try {
    if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
  } catch (e) {
    log.warn(`Could not delete ${localFile}: ${e.message}`);
  }

  // Format and send
  const callWithMeta = { ...call, durationSeconds: call.duration_seconds };
  const message = fmtCallReview(callWithMeta, analysis);

  // Add GH Actions badge so user knows source
  const badge = `\n\n_🤖 via GitHub Actions · ${todayDateCT()}_`;
  await tgSend(telegramId, message + badge);

  log.info(`Review sent to ${telegramId} (score: ${analysis.score})`);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  if (err.stack) log.error(err.stack);
  process.exit(1);
});
