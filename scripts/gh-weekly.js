'use strict';

/**
 * gh-weekly.js — Weekly Performance Report
 * SELF-CONTAINED: generates missing daily reviews on-the-fly.
 */

const {
  config, log, db, tgSend,
  todayDateCT, todayShiftUtcRange,
  weekRangeEndingSaturday, sleep, scoreEmoji, safeJson,
  syncAndAnalyzeCalls, generateDailySummary, generateWeeklySummary
} = require('./gh-shared');

async function main() {
  log.info('=== gh-weekly.js started ===');
  log.info(`Current UTC:     ${new Date().toISOString()}`);
  log.info(`GH_USERS secret: "${config.bot.ghUsers || '(NOT SET)'}"`);
  log.info(`Admin IDs:       ${config.bot.adminIds.join(', ') || '(NOT SET)'}`);

  const weekStartOverride = process.env.WEEK_START_OVERRIDE || '';
  const weekEndOverride   = process.env.WEEK_END_OVERRIDE   || '';

  let weekStart, weekEnd;
  if (weekStartOverride && weekEndOverride) {
    weekStart = weekStartOverride;
    weekEnd   = weekEndOverride;
    log.info(`Manual week: ${weekStart} → ${weekEnd}`);
  } else {
    const today = todayDateCT();
    const r     = weekRangeEndingSaturday(today);
    weekStart   = r.weekStart;
    weekEnd     = r.weekEnd;
    log.info(`Auto week (CT today: ${today}): ${weekStart} → ${weekEnd}`);
  }

  const users = db.getAllActiveUsers();

  if (users.length === 0) {
    log.warn('No registered users found.');
    const msg =
      `⚠️ *Weekly Report — No Users Registered*\n\n` +
      `No users found in database.\n\n` +
      `*How to fix:*\n` +
      `Settings → Secrets → Actions → New repository secret\n\n` +
      `Name: \`GH_USERS\`\n` +
      `Value: \`1398648318:+13125551234\`\n\n` +
      `_🤖 via GitHub Actions_`;
    for (const adminId of config.bot.adminIds) {
      try { await tgSend(adminId, msg); } catch {}
    }
    process.exit(0);
  }

  log.info(`Processing ${users.length} user(s): ${users.map(u => u.telegram_id).join(', ')}`);

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
  const telegramId  = user.telegram_id;
  const forceResend = process.env.FORCE_RESEND === 'true';

  log.info(`User ${telegramId} | ${weekStart} → ${weekEnd}`);

  if (db.weeklyReviewExists(telegramId, weekStart) && !forceResend) {
    log.info(`Weekly already exists for week ${weekStart}, skipping`);
    return;
  }

  // ── Ensure daily reviews exist for each working day ───────────────────────
  const workingDays = getWorkingDays(weekStart, weekEnd);
  log.info(`Working days: ${workingDays.join(', ')}`);

  for (const dayStr of workingDays) {
    if (!db.dailyReviewExists(telegramId, dayStr)) {
      log.info(`No daily review for ${dayStr} — generating now`);
      await generateDayReview(user, dayStr);
      await sleep(2000);
    } else {
      log.info(`Daily review for ${dayStr} ✓`);
    }
  }

  // ── Get all daily reviews ─────────────────────────────────────────────────
  const dailyReviews = db.getDailyReviews(telegramId, weekStart, weekEnd);
  log.info(`Collected ${dailyReviews.length} daily reviews`);

  if (dailyReviews.length === 0) {
    await tgSend(telegramId,
      `📅 *Weekly Report – ${weekStart} → ${weekEnd}*\n\n` +
      `No data found for this week.\n\n_🤖 via GitHub Actions_`
    );
    return;
  }

  // ── Generate weekly GPT summary ───────────────────────────────────────────
  log.info('Generating weekly summary...');
  const result     = await generateWeeklySummary(dailyReviews, weekStart, weekEnd);
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

async function generateDayReview(user, dayStr) {
  const telegramId = user.telegram_id;
  const { dateFrom, dateTo } = todayShiftUtcRange(dayStr);
  log.info(`Syncing ${dayStr}: ${dateFrom} → ${dateTo}`);
  await syncAndAnalyzeCalls(user, dateFrom, dateTo);

  const calls    = db.getCallsForDate(telegramId, dayStr);
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

function getWorkingDays(weekStart, weekEnd) {
  const days = [];
  const cur  = new Date(weekStart + 'T12:00:00Z');
  const end  = new Date(weekEnd   + 'T12:00:00Z');
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow >= 1 && dow <= 6) days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  if (err.stack) log.error(err.stack);
  process.exit(1);
});
