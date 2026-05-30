'use strict';

/**
 * gh-weekly.js
 * Runs every Saturday at 7:05 PM CT via GitHub Actions.
 * Collects daily reviews for Mon-Sat, generates weekly GPT summary, sends to Telegram.
 */

const {
  config, log, db, tgSend,
  todayDateCT, weekRangeEndingSaturday, sleep,
  generateWeeklySummary
} = require('./gh-shared');

async function main() {
  log.info('=== gh-weekly.js started ===');

  // Allow manual override of week range
  const weekStartOverride = process.env.WEEK_START_OVERRIDE || '';
  const weekEndOverride = process.env.WEEK_END_OVERRIDE || '';

  let weekStart, weekEnd;
  if (weekStartOverride && weekEndOverride) {
    weekStart = weekStartOverride;
    weekEnd = weekEndOverride;
    log.info(`Using manual week range: ${weekStart} → ${weekEnd}`);
  } else {
    // Auto: today should be Saturday; week = Mon-Sat
    const today = todayDateCT();
    const range = weekRangeEndingSaturday(today);
    weekStart = range.weekStart;
    weekEnd = range.weekEnd;
    log.info(`Auto week range: ${weekStart} → ${weekEnd}`);
  }

  const users = db.getAllActiveUsers();
  if (users.length === 0) {
    log.warn('No active users in DB');
    process.exit(0);
  }

  for (const user of users) {
    const telegramId = user.telegram_id;
    try {
      await processWeeklyForUser(telegramId, weekStart, weekEnd);
    } catch (err) {
      log.error(`Weekly report error for ${telegramId}: ${err.message}`);
      await tgSend(telegramId,
        `❌ *Weekly Report Error*\n\nFailed to generate weekly report.\n\`${err.message}\``
      );
    }
    await sleep(3000);
  }

  log.info('=== gh-weekly.js finished ===');
}

async function processWeeklyForUser(telegramId, weekStart, weekEnd) {
  // Avoid duplicates
  if (db.weeklyReviewExists(telegramId, weekStart)) {
    log.info(`Weekly review already exists for ${telegramId} week ${weekStart}, skipping`);
    return;
  }

  const dailyReviews = db.getDailyReviews(telegramId, weekStart, weekEnd);
  log.info(`User ${telegramId}: ${dailyReviews.length} daily reviews for ${weekStart}–${weekEnd}`);

  if (dailyReviews.length === 0) {
    log.info(`No daily reviews found, skipping weekly report for ${telegramId}`);
    await tgSend(telegramId,
      `📅 *Weekly Report – ${weekStart} → ${weekEnd}*\n\n` +
      `No daily reports found for this week. Make sure end-of-shift reports ran correctly each day.\n\n` +
      `_🤖 via GitHub Actions_`
    );
    return;
  }

  // Generate summary
  const result = await generateWeeklySummary(dailyReviews, weekStart, weekEnd);

  // Save to DB
  const totalCalls = dailyReviews.reduce((s, r) => s + (r.total_calls || 0), 0);
  db.saveWeeklyReview(
    telegramId, weekStart, weekEnd,
    result.summary,
    result.overallScore,
    totalCalls
  );

  // Build message
  const scoreStr = result.overallScore !== null
    ? `\n🏆 Weekly Average: *${result.overallScore}/100* ${scoreEmoji(result.overallScore)}`
    : '';

  const header =
    `📅 *Weekly Performance Report*\n` +
    `🗓 Period: ${weekStart} → ${weekEnd}\n` +
    `📆 Days Reviewed: ${dailyReviews.length}\n` +
    `📞 Total Calls: ${totalCalls}` +
    scoreStr +
    `\n_🤖 via GitHub Actions_\n\n`;

  await tgSend(telegramId, header + result.summary);
  log.info(`Weekly report sent to ${telegramId}`);
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
