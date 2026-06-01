'use strict';

/**
 * gh-weekly.js — Weekly Performance Report
 *
 * SELF-CONTAINED: generates daily summaries on-the-fly if they don't exist,
 * then creates a weekly aggregate. Does NOT depend on daily workflow having run.
 */

const {
  config, log, db, tgSend,
  todayDateCT, todayShiftUtcRange,
  ctDayToUtcRange, weekRangeEndingSaturday,
  sleep, scoreEmoji, safeJson,
  syncAndAnalyzeCalls, generateDailySummary, generateWeeklySummary
} = require('./gh-shared');

async function main() {
  log.info('=== gh-weekly.js started ===');
  log.info(`Current UTC: ${new Date().toISOString()}`);

  const weekStartOverride = process.env.WEEK_START_OVERRIDE || '';
  const weekEndOverride   = process.env.WEEK_END_OVERRIDE   || '';

  let weekStart, weekEnd;
  if (weekStartOverride && weekEndOverride) {
    weekStart = weekStartOverride;
    weekEnd   = weekEndOverride;
    log.info(`Manual week: ${weekStart} → ${weekEnd}`);
  } else {
    const today = todayDateCT();
    const r = weekRangeEndingSaturday(today);
    weekStart = r.weekStart;
    weekEnd   = r.weekEnd;
    log.info(`Auto week (CT today: ${today}): ${weekStart} → ${weekEnd}`);
  }

  const users = db.getAllActiveUsers();
  if (users.length === 0) {
    log.warn('No active users. Set GH_USERS secret or register via bot.');
    process.exit(0);
  }

  for (const user of users) {
    try {
      await processWeeklyForUser(user, weekStart, weekEnd);
    } catch (err) {
      log.error(`Weekly report failed for ${user.telegram_id}: ${err.message}`);
      if (err.stack) log.error(err.stack);
      try {
        await tgSend(user.telegram_id,
          `❌ *Weekly Report Error*\n\n\`${err.message}\`\n\n_🤖 GitHub Actions_`
        );
      } catch {}
    }
    await sleep(3000);
  }

  log.info('=== gh-weekly.js finished ===');
}

async function processWeeklyForUser(user, weekStart, weekEnd) {
  const telegramId = user.telegram_id;
  const forceResend = process.env.FORCE_RESEND === 'true';

  log.info(`Processing weekly for ${telegramId}: ${weekStart} → ${weekEnd}`);

  if (db.weeklyReviewExists(telegramId, weekStart) && !forceResend) {
    log.info(`Weekly review already exists for week ${weekStart}, skipping`);
    return;
  }

  // ── Step 1: Ensure daily reviews exist for each working day ───────────────
  // If daily workflow didn't run on some days, generate those summaries now.
  const workingDays = getWorkingDays(weekStart, weekEnd);
  log.info(`Week has ${workingDays.length} working days: ${workingDays.join(', ')}`);

  for (const dayStr of workingDays) {
    if (!db.dailyReviewExists(telegramId, dayStr)) {
      log.info(`No daily review for ${dayStr} — generating now...`);
      await generateDayReview(user, dayStr);
      await sleep(2000);
    } else {
      log.info(`Daily review for ${dayStr} exists ✓`);
    }
  }

  // ── Step 2: Get all daily reviews ────────────────────────────────────────
  const dailyReviews = db.getDailyReviews(telegramId, weekStart, weekEnd);
  log.info(`${dailyReviews.length} daily reviews collected`);

  if (dailyReviews.length === 0) {
    await tgSend(telegramId,
      `📅 *Weekly Report – ${weekStart} → ${weekEnd}*\n\n` +
      `No data found for this week.\n\n_🤖 via GitHub Actions_`
    );
    return;
  }

  // ── Step 3: Generate weekly GPT summary ──────────────────────────────────
  log.info('Generating weekly summary...');
  const result = await generateWeeklySummary(dailyReviews, weekStart, weekEnd);

  const totalCalls = dailyReviews.reduce((s, r) => s + (r.total_calls || 0), 0);
  db.saveWeeklyReview(telegramId, weekStart, weekEnd, result.summary, result.overallScore, totalCalls);

  const scoreStr = result.overallScore !== null
    ? `\n🏆 Weekly Average: *${result.overallScore}/100* ${scoreEmoji(result.overallScore)}`
    : '';

  const header =
    `📅 *Weekly Performance Report*\n` +
    `🗓 ${weekStart} → ${weekEnd}\n` +
    `📆 Days: *${dailyReviews.length}* | 📞 Calls: *${totalCalls}*` +
    scoreStr +
    `\n_🤖 via GitHub Actions_\n\n`;

  await tgSend(telegramId, header + result.summary);
  log.info(`✅ Weekly report sent to ${telegramId}`);
}

/**
 * Generate and save a daily review for a specific day.
 * Fetches + analyzes calls if needed.
 */
async function generateDayReview(user, dayStr) {
  const telegramId = user.telegram_id;

  // Sync that day's shift calls
  const { dateFrom, dateTo } = todayShiftUtcRange(dayStr);
  log.info(`Syncing ${dayStr}: ${dateFrom} → ${dateTo}`);
  await syncAndAnalyzeCalls(user, dateFrom, dateTo);

  const calls = db.getCallsForDate(telegramId, dayStr);
  log.info(`${dayStr}: ${calls.length} analyzed calls`);

  const enriched = calls.map(c => ({
    ...c, durationSeconds: c.duration_seconds, analysis: safeJson(c.analysis_json)
  }));

  const result = calls.length > 0
    ? await generateDailySummary(enriched, dayStr)
    : { summary: 'No calls analyzed.', overallScore: null, totalCalls: 0 };

  db.saveDailyReview(
    telegramId, dayStr,
    result.summary, result.overallScore,
    result.totalCalls, result.totalCalls
  );
  log.info(`Daily review saved for ${dayStr} (${result.totalCalls} calls, score: ${result.overallScore})`);
}

/**
 * Returns array of date strings (YYYY-MM-DD) for Mon-Sat in the given range.
 */
function getWorkingDays(weekStart, weekEnd) {
  const days = [];
  const start = new Date(weekStart + 'T12:00:00Z');
  const end   = new Date(weekEnd   + 'T12:00:00Z');
  const cur   = new Date(start);
  while (cur <= end) {
    const dow = cur.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    if (dow >= 1 && dow <= 6) { // Mon–Sat
      days.push(cur.toISOString().slice(0, 10));
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  if (err.stack) log.error(err.stack);
  process.exit(1);
});
