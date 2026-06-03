'use strict';

/**
 * gh-daily.js — End-of-Shift Daily Report
 * SELF-CONTAINED: does its own final sync before reporting.
 */

const {
  config, log, db, tgSend,
  todayDateCT, todayShiftUtcRange,
  sleep, scoreEmoji, safeJson,
  syncAndAnalyzeCalls, generateDailySummary
} = require('./gh-shared');

async function main() {
  log.info('=== gh-daily.js started ===');

  const reportDate = process.env.DATE_OVERRIDE || todayDateCT();
  log.info(`Report date (CT): ${reportDate}`);
  log.info(`Current UTC:      ${new Date().toISOString()}`);
  log.info(`GH_USERS secret:  "${config.bot.ghUsers || '(NOT SET)'}"`);
  log.info(`Admin IDs:        ${config.bot.adminIds.join(', ') || '(NOT SET)'}`);

  const users = db.getAllActiveUsers();

  if (users.length === 0) {
    log.warn('No registered users found.');
    const msg =
      `⚠️ *Daily Report — No Users Registered*\n\n` +
      `No users found in the database.\n\n` +
      `*How to fix:*\n` +
      `Go to your GitHub repo:\n` +
      `Settings → Secrets → Actions → New repository secret\n\n` +
      `Name: \`GH_USERS\`\n` +
      `Value: \`1398648318:+13125551234\`\n\n` +
      `_(Replace with your Telegram ID and phone number)_\n\n` +
      `_🤖 via GitHub Actions_`;

    for (const adminId of config.bot.adminIds) {
      try { await tgSend(adminId, msg); } catch (e) { log.error(`tgSend admin: ${e.message}`); }
    }
    process.exit(0);
  }

  log.info(`Processing ${users.length} user(s): ${users.map(u => u.telegram_id).join(', ')}`);

  for (const user of users) {
    try {
      await processDailyForUser(user, reportDate);
    } catch (err) {
      log.error(`Daily report failed for ${user.telegram_id}: ${err.message}`);
      if (err.stack) log.error(err.stack);
      try {
        await tgSend(user.telegram_id,
          `❌ *Daily Report Error – ${reportDate}*\n\n` +
          `\`${err.message}\`\n\n_🤖 GitHub Actions_`
        );
      } catch {}
    }
    await sleep(3000);
  }

  log.info('=== gh-daily.js finished ===');
}

async function processDailyForUser(user, reportDate) {
  const telegramId  = user.telegram_id;
  const forceResend = process.env.FORCE_RESEND === 'true';

  log.info(`User ${telegramId} | phone: ${user.rc_phone_number} | ext: ${user.rc_extension_id || 'none'}`);

  if (db.dailyReviewExists(telegramId, reportDate) && !forceResend) {
    log.info(`Daily review already sent for ${reportDate}, skipping (set FORCE_RESEND=true to override)`);
    return;
  }

  // ── Final sync: fetch + analyze today's shift calls ───────────────────────
  log.info('Running final shift sync...');
  const { dateFrom, dateTo } = todayShiftUtcRange(reportDate);
  log.info(`Shift UTC window: ${dateFrom} → ${dateTo}`);
  await syncAndAnalyzeCalls(user, dateFrom, dateTo);

  // ── Collect analyzed calls for today ─────────────────────────────────────
  const calls = db.getCallsForDate(telegramId, reportDate);
  log.info(`Analyzed calls found for ${reportDate}: ${calls.length}`);

  if (calls.length === 0) {
    log.warn('No analyzed calls. Reasons: no calls today / no recordings / calls too short / RC auth issue');
    const msg =
      `📋 *End of Shift – ${reportDate}*\n\n` +
      `No calls were analyzed today.\n\n` +
      `Possible reasons:\n` +
      `• No calls were made during shift hours (9 AM – 7 PM CT)\n` +
      `• Calls had no recordings enabled in RingCentral\n` +
      `• All calls shorter than ${config.bot.minCallDurationSeconds}s\n\n` +
      `_🤖 via GitHub Actions_`;
    await tgSend(telegramId, msg);
    db.saveDailyReview(telegramId, reportDate, 'No calls analyzed.', null, 0, 0);
    return;
  }

  // ── Generate GPT summary ──────────────────────────────────────────────────
  log.info(`Generating summary for ${calls.length} calls...`);
  const enriched = calls.map(c => ({
    ...c, durationSeconds: c.duration_seconds,
    analysis: safeJson(c.analysis_json)
  }));

  const result = await generateDailySummary(enriched, reportDate);

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
  log.info(`✅ Daily report sent to ${telegramId} (${calls.length} calls, score: ${result.overallScore})`);

  // ── Cleanup: delete today's calls from DB after report is sent ────────────
  // This ensures tomorrow's report only contains tomorrow's calls.
  // daily_reviews table is kept intact (needed for weekly report).
  const deleted = db.deleteCallsForDate(telegramId, reportDate);
  log.info(`🧹 Cleanup: removed ${deleted} call records for ${reportDate}`);

  // Also remove any stale calls older than 2 days as safety net
  db.deleteCallsOlderThan(2);
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  if (err.stack) log.error(err.stack);
  process.exit(1);
});
