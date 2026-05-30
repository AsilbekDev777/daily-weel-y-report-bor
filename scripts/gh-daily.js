'use strict';

/**
 * gh-daily.js
 * Runs at 7:00 PM CT via GitHub Actions.
 * Collects all analyzed calls for the day, generates GPT summary, sends to Telegram.
 */

const {
  config, log, db, tgSend,
  todayDateCT, sleep,
  generateDailySummary
} = require('./gh-shared');

async function main() {
  log.info('=== gh-daily.js started ===');

  // Determine which date to report
  const dateOverride = process.env.DATE_OVERRIDE || '';
  const reportDate = dateOverride || todayDateCT();
  log.info(`Reporting date: ${reportDate}`);

  const users = db.getAllActiveUsers();
  if (users.length === 0) {
    log.warn('No active users in DB');
    process.exit(0);
  }

  for (const user of users) {
    const telegramId = user.telegram_id;
    try {
      await processDailyForUser(telegramId, reportDate);
    } catch (err) {
      log.error(`Daily report error for ${telegramId}: ${err.message}`);
      await tgSend(telegramId,
        `❌ *Daily Report Error*\n\nFailed to generate today's report.\n\`${err.message}\``
      );
    }
    await sleep(3000);
  }

  log.info('=== gh-daily.js finished ===');
}

async function processDailyForUser(telegramId, reportDate) {
  // Avoid sending duplicate reports
  if (db.dailyReviewExists(telegramId, reportDate)) {
    log.info(`Daily review already exists for ${telegramId} on ${reportDate}, skipping`);
    return;
  }

  const calls = db.getCallsForDate(telegramId, reportDate);
  log.info(`User ${telegramId}: ${calls.length} analyzed calls on ${reportDate}`);

  // Enrich calls with parsed analysis
  const enriched = calls.map(c => ({
    ...c,
    durationSeconds: c.duration_seconds,
    analysis: safeJson(c.analysis_json)
  }));

  // Generate summary
  const result = await generateDailySummary(enriched, reportDate);

  // Save to DB
  db.saveDailyReview(
    telegramId, reportDate,
    result.summary,
    result.overallScore,
    calls.length,
    calls.length
  );

  // Build message
  const scoreStr = result.overallScore !== null
    ? `\n⭐ Average Score: *${result.overallScore}/100* ${scoreEmoji(result.overallScore)}`
    : '';

  const header =
    `🏁 *End of Shift Report*\n` +
    `📅 Date: ${reportDate}\n` +
    `📞 Calls Analyzed: ${calls.length}` +
    scoreStr +
    `\n_🤖 via GitHub Actions_\n\n`;

  await tgSend(telegramId, header + result.summary);
  log.info(`Daily report sent to ${telegramId}`);
}

function safeJson(str) {
  try { return str ? JSON.parse(str) : {}; } catch { return {}; }
}

function scoreEmoji(s) {
  if (s >= 90) return '🌟'; if (s >= 75) return '✅';
  if (s >= 60) return '🟡'; if (s >= 40) return '🟠'; return '🔴';
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  if (err.stack) log.error(err.stack);
  process.exit(1);
});
