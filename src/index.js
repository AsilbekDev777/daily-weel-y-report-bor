'use strict';

require('dotenv').config();

const { Telegraf } = require('telegraf');
const config = require('./utils/config');
const logger = require('./utils/logger');
const db = require('./db/database');
const { registerHandlers } = require('./handlers/botHandlers');
const { startScheduler, stopScheduler } = require('./services/scheduler');
const fs = require('fs');
const path = require('path');

// ─── Ensure required directories exist ───────────────────────────────────────
[
  path.dirname(path.resolve(config.bot.databasePath)),
  path.resolve(config.bot.downloadDir),
  path.resolve('./data/logs')
].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Validate required env vars ───────────────────────────────────────────────
const required = [
  ['TELEGRAM_BOT_TOKEN', config.telegram.token],
  ['OPENAI_API_KEY', config.openai.apiKey],
  ['RC_CLIENT_ID', config.ringcentral.clientId],
  ['RC_CLIENT_SECRET', config.ringcentral.clientSecret],
  ['RC_JWT', config.ringcentral.jwt]
];

for (const [name, value] of required) {
  if (!value) {
    logger.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

// ─── Initialize DB ────────────────────────────────────────────────────────────
db.getDb();

// ─── Initialize Bot ───────────────────────────────────────────────────────────
const bot = new Telegraf(config.telegram.token, {
  handlerTimeout: config.telegram.handlerTimeoutMs
});

// Register all handlers
registerHandlers(bot);

// Global error handler
bot.catch((err, ctx) => {
  logger.error(`Bot error for update ${ctx?.update?.update_id}: ${err.message}`);
  if (err.stack) logger.debug(err.stack);
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  try {
    logger.info('========================================');
    logger.info('  RingCentral Call Review Bot');
    logger.info('========================================');
    logger.info(`Shift hours: 9:00 AM – 7:00 PM (CT)`);
    logger.info(`Poll interval: ${config.bot.pollCron}`);
    logger.info(`Max analyze per sync: ${config.bot.maxAnalyzePerSync}`);
    logger.info(`Min call duration: ${config.bot.minCallDurationSeconds}s`);
    logger.info(`Debug mode: ${config.bot.debugMode}`);

    // Log current CT time so we can verify timezone is correct on the server
    const timeUtils = require('./utils/time');
    timeUtils.logCurrentShiftStatus(logger);

    // Start scheduler
    startScheduler(bot);

    // Launch bot (long polling)
    await bot.launch();
    logger.info('Bot is running and listening for messages...');

    // Notify admins
    for (const adminId of config.bot.adminTelegramIds) {
      try {
        await bot.telegram.sendMessage(
          adminId,
          `🤖 *Call Review Bot started*\n\n` +
          `✅ All systems operational\n` +
          `🕐 Shift: 9:00 AM – 7:00 PM CT\n` +
          `🔄 Poll: ${config.bot.pollCron}\n` +
          `📅 ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        logger.warn(`Could not notify admin ${adminId}: ${e.message}`);
      }
    }
  } catch (err) {
    logger.error(`Failed to start bot: ${err.message}`);
    if (err.stack) logger.error(err.stack);
    process.exit(1);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.once('SIGINT', () => {
  logger.info('SIGINT received – shutting down...');
  stopScheduler();
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  logger.info('SIGTERM received – shutting down...');
  stopScheduler();
  bot.stop('SIGTERM');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  if (err.stack) logger.error(err.stack);
});

main();
