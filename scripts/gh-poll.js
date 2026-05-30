'use strict';

/**
 * gh-poll.js
 * Runs during shift hours every 30 min via GitHub Actions.
 * Silently fetches calls, transcribes and analyzes — saves to DB only.
 * NO per-call Telegram messages. Only the end-of-shift report (gh-daily.js) notifies the user.
 */

const fs = require('fs');
const {
  config, log, db,
  isShiftActive, lookbackRange, lastNDaysRange, sleep,
  fetchCallLogs, downloadRecording, parseRecord,
  transcribeAudio, analyzeCall
} = require('./gh-shared');

const isBackfill = process.argv.includes('--backfill');

async function main() {
  log.info(`=== gh-poll.js started [${isBackfill ? 'BACKFILL' : 'POLL'}] ===`);

  if (!isBackfill && process.env.GH_ACTIONS_MODE === 'true' && !isShiftActive()) {
    log.info('Outside shift hours (9 AM – 7 PM CT). Exiting.');
    process.exit(0);
  }

  const users = db.getAllActiveUsers();
  if (users.length === 0) {
    log.warn('No registered users found in DB.');
    process.exit(0);
  }

  log.info(`Processing ${users.length} user(s)`);

  for (const user of users) {
    try {
      await processUser(user);
    } catch (err) {
      log.error(`processUser ${user.telegram_id}: ${err.message}`);
    }
    await sleep(3000);
  }

  log.info('=== gh-poll.js finished ===');
}

async function processUser(user) {
  const { telegram_id: telegramId, rc_extension_id: extensionId } = user;
  log.info(`User ${telegramId} | ext: ${extensionId || 'account-level'}`);

  const range = isBackfill
    ? lastNDaysRange(config.bot.backfillDays)
    : lookbackRange(config.bot.lookbackMinutes);

  // Fetch and store new calls
  let rawCalls;
  try {
    rawCalls = await fetchCallLogs(range.dateFrom, range.dateTo, extensionId);
  } catch (err) {
    log.error(`fetchCallLogs failed: ${err.message}`);
    return;
  }

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

  // Silently transcribe + analyze — NO Telegram notification per call
  const limit = isBackfill ? 10 : config.bot.maxAnalyzePerSync;
  const toAnalyze = db.getUnanalyzed(telegramId, limit);
  log.info(`${toAnalyze.length} calls queued for silent analysis`);

  for (const call of toAnalyze) {
    try {
      await analyzeSilently(call);
    } catch (err) {
      log.error(`analyzeSilently ${call.rc_call_id}: ${err.message}`);
    }
    await sleep(config.openai?.delayMs || 5000);
  }

  db.setLastSyncedAt(telegramId, new Date().toISOString());
}

async function analyzeSilently(call) {
  log.info(`Analyzing ${call.rc_call_id} silently...`);

  let localFile = call.local_file;
  if (!localFile || !fs.existsSync(localFile)) {
    localFile = await downloadRecording(call.rc_call_id, call.recording_url);
    if (!localFile) { log.warn(`Download failed for ${call.rc_call_id}`); return; }
    db.updateCallLocalFile(call.rc_call_id, localFile);
  }

  let transcription;
  try {
    transcription = await transcribeAudio(localFile);
  } catch (err) {
    log.error(`Transcription error: ${err.message}`); return;
  }
  if (!transcription || transcription.trim().length < 10) {
    log.warn(`Transcription too short for ${call.rc_call_id}`); return;
  }

  let analysis;
  try {
    analysis = await analyzeCall(transcription, {
      direction: call.direction,
      durationSeconds: call.duration_seconds,
      startTime: call.start_time
    });
  } catch (err) {
    log.error(`Analysis error: ${err.message}`); return;
  }

  // Save to DB — no Telegram message
  db.updateCallAnalysis(call.rc_call_id, transcription, analysis, analysis.score);
  log.info(`Call ${call.rc_call_id} saved (score: ${analysis.score})`);

  try {
    if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
  } catch (e) {
    log.warn(`Could not delete ${localFile}`);
  }
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
