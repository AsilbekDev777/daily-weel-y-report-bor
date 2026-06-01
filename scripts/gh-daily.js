'use strict';

/**
 * gh-daily.js — End-of-Shift Daily Report
 *
 * SELF-CONTAINED: Does its own final sync before reporting.
 * Does NOT depend on poll job having run — works standalone.
 */

const {
  config, log, db, tgSend,
  todayDateCT, todayShiftUtcRange,
  sleep, scoreEmoji, safeJson,
  syncAndAnalyzeCalls, generateDailySummary
} = require('./gh-shared');

async function main() {
  log.info('=== gh-daily.js started ===');

  // Determine report date
  const reportDate = process.env.DATE_OVERRIDE || todayDateCT();
  log.info(`Report date (CT): ${reportDate}`);
  log.info(`Current UTC time: ${new Date().toISOString()}`);

  const users = db.getAllActiveUsers();
  if (users.length === 0) {
    log.warn('No active users found.');
    log.warn('→ Set GH_USERS secret: "TELEGRAM_ID:+1XXXXXXXXXX"');
    log.warn('→ Or register users via bot /start command first.');
    process.exit(0);
  }

  for (const user of users) {
    try {
      await processDailyForUser(user, reportDate);
    } catch (err) {
      log.error(`Daily report failed for ${user.telegram_id}: ${err.message}`);
      if (err.stack) log.error(err.stack);
      try {
        await tgSend(user.telegram_id,
          `❌ *Daily Report Error*\n\nSomething went wrong generating today's report.\n` +
          `\`${err.message}\`\n\n_🤖 GitHub Actions_`
        );
      } catch {}
    }
    await sleep(3000);
  }

  log.info('=== gh-daily.js finished ===');
}

async function processDailyForUser(user, reportDate) {
  const telegramId = user.telegram_id;
  const forceResend = process.env.FORCE_RESEND === 'true';

  log.info(`Processing user ${telegramId}`);

  if (db.dailyReviewExists(telegramId, reportDate) && !forceResend) {
    log.info(`Daily review already exists for ${reportDate}, skipping`);
    return;
  }

  // ── Step 1: Final sync — fetch & analyze today's shift calls ──────────────
  // This makes the daily job self-contained regardless of whether poll ran.
  log.info('Step 1: Final sync of today\'s shift calls...');
  const { dateFrom, dateTo } = todayShiftUtcRange(reportDate);
  log.info(`Shift UTC window: ${dateFrom} → ${dateTo}`);
  await syncAndAnalyzeCalls(user, dateFrom, dateTo);

  // ── Step 2: Collect all analyzed calls for the day ────────────────────────
  const calls = db.getCallsForDate(telegramId, reportDate);
  log.info(`Step 2: ${calls.length} analyzed calls found for ${reportDate}`);

  if (calls.length === 0) {
    log.warn('No analyzed calls found. Possible reasons:');
    log.warn('  - No calls were made today');
    log.warn('  - No calls had recordings');
    log.warn(`  - All calls were shorter than ${config.bot.minCallDurationSeconds}s`);
    log.warn('  - RingCentral auth issue');

    const msg =
      `📋 *End of Shift – ${reportDate}*\n\n` +
      `No calls were analyzed today.\n\n` +
      `Possible reasons:\n` +
      `• No calls were made during shift hours\n` +
      `• Recordings were not available\n` +
      `• Calls were shorter than ${config.bot.minCallDurationSeconds} seconds\n\n` +
      `_🤖 via GitHub Actions_`;
    await tgSend(telegramId, msg);
    db.saveDailyReview(telegramId, reportDate, 'No calls analyzed.', null, 0, 0);
    return;
  }

  // ── Step 3: Generate GPT summary ─────────────────────────────────────────
  log.info(`Step 3: Generating daily summary for ${calls.length} calls...`);
  const enriched = calls.map(c => ({
    ...c,
    durationSeconds: c.duration_seconds,
    analysis: safeJson(c.analysis_json)
  }));

  const result = await generateDailySummary(enriched, reportDate);

  // ── Step 4: Save and send ─────────────────────────────────────────────────
  db.saveDailyReview(
    telegramId, reportDate,
    result.summary, result.overallScore,
    calls.length, calls.length
  );

  const scoreStr = result.overallScore !== null
    ? `\n⭐ Average Score: *${result.overallScore}/100* ${scoreEmoji(result.overallScore)}`
    : '';

  const header =
    `🏁 *End of Shift Report – ${reportDate}*\n` +
    `📞 Calls Analyzed: *${calls.length}*` +
    scoreStr +
    `\n_🤖 via GitHub Actions_\n\n`;

  await tgSend(telegramId, header + result.summary);
  log.info(`✅ Daily report sent to ${telegramId}`);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  if (err.stack) log.error(err.stack);
  process.exit(1);
});
