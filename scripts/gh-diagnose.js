'use strict';

/**
 * gh-diagnose.js
 * Tests all connections and sends a status report to Telegram.
 * Run this first to verify everything is configured correctly.
 */

const {
  config, log, db, tgSend,
  todayDateCT, currentHourCT, isShiftActive,
  getRcToken, fetchCallLogs, lookbackRange
} = require('./gh-shared');

async function main() {
  log.info('=== gh-diagnose.js started ===');

  const results = {
    timestamp: new Date().toISOString(),
    ctDate: todayDateCT(),
    ctHour: currentHourCT(),
    shiftActive: isShiftActive(),
    telegram: false,
    telegramError: null,
    ringcentral: false,
    ringcentralError: null,
    database: false,
    databaseError: null,
    users: [],
    recentCalls: 0,
    secrets: {}
  };

  // ── 1. Check secrets presence ─────────────────────────────────────────────
  results.secrets = {
    TELEGRAM_BOT_TOKEN: config.telegram.token ? '✅ Set' : '❌ MISSING',
    OPENAI_API_KEY:     config.openai.apiKey   ? '✅ Set' : '❌ MISSING',
    RC_CLIENT_ID:       config.rc.clientId     ? '✅ Set' : '❌ MISSING',
    RC_CLIENT_SECRET:   config.rc.clientSecret ? '✅ Set' : '❌ MISSING',
    RC_JWT:             config.rc.jwt          ? '✅ Set' : '❌ MISSING',
    GH_USERS:           config.bot.ghUsers     ? `✅ "${config.bot.ghUsers}"` : '❌ MISSING — reports will NOT be sent!'
  };

  log.info('Secrets check:');
  for (const [k, v] of Object.entries(results.secrets)) {
    log.info(`  ${k}: ${v}`);
  }

  // ── 2. Test Telegram ──────────────────────────────────────────────────────
  log.info('Testing Telegram...');
  try {
    const axios = require('axios');
    const resp = await axios.get(
      `${config.telegram.apiBase}/getMe`,
      { timeout: 10000 }
    );
    if (resp.data.ok) {
      results.telegram = true;
      log.info(`Telegram OK: @${resp.data.result.username}`);
    }
  } catch (e) {
    results.telegramError = e.message;
    log.error(`Telegram FAILED: ${e.message}`);
  }

  // ── 3. Test Database ──────────────────────────────────────────────────────
  log.info('Testing Database...');
  try {
    const users = db.getAllActiveUsers();
    results.database = true;
    results.users = users.map(u => ({
      telegramId: u.telegram_id,
      phone: u.rc_phone_number,
      extensionId: u.rc_extension_id || 'not set'
    }));
    log.info(`DB OK: ${users.length} active user(s)`);
  } catch (e) {
    results.databaseError = e.message;
    log.error(`DB FAILED: ${e.message}`);
  }

  // ── 4. Test RingCentral ───────────────────────────────────────────────────
  log.info('Testing RingCentral...');
  try {
    await getRcToken();
    results.ringcentral = true;
    log.info('RingCentral auth OK');

    // Try fetching last hour of calls
    const { dateFrom, dateTo } = lookbackRange(60);
    const calls = await fetchCallLogs(dateFrom, dateTo, null);
    results.recentCalls = calls.length;
    log.info(`RingCentral: ${calls.length} calls in last 60 min`);
  } catch (e) {
    results.ringcentralError = e.message;
    log.error(`RingCentral FAILED: ${e.message}`);
  }

  // ── 5. Build and send report ──────────────────────────────────────────────
  const statusIcon = (ok) => ok ? '✅' : '❌';

  let report =
    `🔍 *GitHub Actions Diagnostics*\n` +
    `📅 CT Date: \`${results.ctDate}\`\n` +
    `🕐 CT Hour: \`${results.ctHour}:00\` (Shift: ${results.shiftActive ? '🟢 Active' : '🔴 Inactive'})\n\n` +
    `*Secrets:*\n`;

  for (const [k, v] of Object.entries(results.secrets)) {
    report += `  ${v.startsWith('✅') ? '✅' : '❌'} \`${k}\`\n`;
  }

  report +=
    `\n*Connections:*\n` +
    `  ${statusIcon(results.telegram)} Telegram Bot\n` +
    `  ${statusIcon(results.database)} SQLite Database\n` +
    `  ${statusIcon(results.ringcentral)} RingCentral API\n`;

  if (results.ringcentralError) {
    report += `\n⚠️ RC Error: \`${results.ringcentralError}\`\n`;
  }

  report += `\n*Users registered:* ${results.users.length}\n`;
  if (results.users.length === 0) {
    report +=
      `\n⚠️ *No users found\\!*\n` +
      `Add \`GH_USERS\` secret:\n` +
      `Format: \`TELEGRAM_ID:+1XXXXXXXXXX\`\n` +
      `Example: \`${config.bot.adminIds[0] || '123456789'}:+13125551234\`\n`;
  } else {
    for (const u of results.users) {
      report += `  • \`${u.telegramId}\` → \`${u.phone}\` (ext: ${u.extensionId})\n`;
    }
  }

  report += `\n*Recent calls (last 60min):* ${results.recentCalls}`;

  if (!results.telegram) {
    // Can't send to Telegram — print to stdout only
    log.error('Cannot send to Telegram — check TELEGRAM_BOT_TOKEN secret');
    log.info('DIAGNOSTIC REPORT:');
    log.info(report);
    process.exit(1);
  }

  // Send to all admin IDs and all registered users
  const recipients = new Set([
    ...config.bot.adminIds,
    ...results.users.map(u => u.telegramId)
  ]);

  for (const chatId of recipients) {
    await tgSend(chatId, report);
    log.info(`Sent diagnostics to ${chatId}`);
  }

  log.info('=== gh-diagnose.js finished ===');

  // Exit with error if critical things are missing
  if (!results.telegram || !results.ringcentral || results.users.length === 0) {
    process.exit(1);
  }
}

main().catch(err => {
  log.error(`Fatal: ${err.message}`);
  if (err.stack) log.error(err.stack);
  process.exit(1);
});
