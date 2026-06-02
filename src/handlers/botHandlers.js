'use strict';

const { Markup } = require('telegraf');
const db = require('../db/database');
const rc = require('../services/ringcentral');
const worker = require('../services/worker');
const config = require('../utils/config');
const logger = require('../utils/logger');
const timeUtils = require('../utils/time');

// Track which users are in the middle of phone-number setup
const pendingSetup = new Set();

function registerHandlers(bot) {
  // ─── /start ───────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const telegramId = String(ctx.from.id);
    const firstName = ctx.from.first_name || 'there';

    db.upsertUser(telegramId);
    const user = db.getUser(telegramId);

    if (user && user.rc_phone_number) {
      await ctx.reply(
        `👋 Welcome back, *${firstName}*!\n\n` +
        `✅ You're already set up with phone number: \`${user.rc_phone_number}\`\n\n` +
        `I'll continue monitoring your calls during shift hours (8:00 AM – 6:00 PM CT) ` +
        `and send you reviews after each analyzed call.\n\n` +
        `📊 Daily reports are sent at end of shift.\n` +
        `📅 Weekly reports are sent every Saturday.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      pendingSetup.add(telegramId);
      await ctx.reply(
        `👋 Hello, *${firstName}*! Welcome to the *Call Quality Review Bot*.\n\n` +
        `I will:\n` +
        `• 🎙 Monitor your RingCentral calls during shift (8 AM – 6 PM CT)\n` +
        `• 📝 Transcribe and analyze each call with AI\n` +
        `• ⭐ Score your performance (0–100) and give advice\n` +
        `• 📊 Send a daily summary at end of shift\n` +
        `• 📅 Send a weekly report every Saturday\n\n` +
        `To get started, please enter your *RingCentral phone number*:\n` +
        `(Format: +1XXXXXXXXXX or 10-digit number)`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ─── /status ─────────────────────────────────────────────────────────────
  bot.command('status', async (ctx) => {
    const telegramId = String(ctx.from.id);
    const user = db.getUser(telegramId);

    if (!user || !user.rc_phone_number) {
      return ctx.reply('⚠️ You are not registered yet. Use /start to set up.');
    }

    const shiftActive = timeUtils.isShiftActive();
    const lastSync = db.getLastSyncedAt(telegramId);

    await ctx.reply(
      `📊 *Your Status*\n\n` +
      `📱 Phone: \`${user.rc_phone_number}\`\n` +
      `🔌 Extension ID: \`${user.rc_extension_id || 'Auto-detected'}\`\n` +
      `🕐 Shift: ${shiftActive ? '🟢 Active (8 AM – 6 PM CT)' : '🔴 Inactive'}\n` +
      `🔄 Last Sync: ${lastSync ? new Date(lastSync).toLocaleString() : 'Never'}\n` +
      `📅 Today: ${timeUtils.todayDateCT()}`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── /help ────────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `🤖 *Call Quality Review Bot – Help*\n\n` +
      `*Commands:*\n` +
      `/start – Register or check your setup\n` +
      `/status – View your current status\n` +
      `/help – Show this help message\n\n` +
      `*How it works:*\n` +
      `1️⃣ Register with your RingCentral phone number\n` +
      `2️⃣ During shift (8 AM – 6 PM CT), I poll your calls every 30 minutes\n` +
      `3️⃣ Each recorded call is transcribed and analyzed by AI\n` +
      `4️⃣ You receive instant feedback on each call\n` +
      `5️⃣ At 6 PM, you receive an end-of-shift summary\n` +
      `6️⃣ Every Saturday, a weekly performance report is sent\n\n` +
      `*Shift Hours:* 8:00 AM – 6:00 PM (Central Time)\n\n` +
      `For issues, contact your administrator.`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── Admin commands ───────────────────────────────────────────────────────
  bot.command('admin', async (ctx) => {
    const telegramId = String(ctx.from.id);
    if (!config.bot.adminTelegramIds.includes(telegramId)) {
      return ctx.reply('⛔ You are not authorized to use admin commands.');
    }

    const users = db.getAllActiveUsers();
    const userList = users.length > 0
      ? users.map(u => `• ${u.telegram_id} – ${u.rc_phone_number}`).join('\n')
      : 'No active users';

    await ctx.reply(
      `🔧 *Admin Panel*\n\n` +
      `👥 Active Users (${users.length}):\n${userList}\n\n` +
      `Commands:\n` +
      `/force_poll – Run poll job now\n` +
      `/force_daily – Run end-of-shift job now\n` +
      `/force_weekly – Run weekly job now`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('force_poll', async (ctx) => {
    const telegramId = String(ctx.from.id);
    if (!config.bot.adminTelegramIds.includes(telegramId)) return;
    await ctx.reply('⏳ Running poll job...');
    try {
      await worker.runPollJob(bot);
      await ctx.reply('✅ Poll job complete.');
    } catch (e) {
      await ctx.reply(`❌ Error: ${e.message}`);
    }
  });

  bot.command('force_daily', async (ctx) => {
    const telegramId = String(ctx.from.id);
    if (!config.bot.adminTelegramIds.includes(telegramId)) return;
    await ctx.reply('⏳ Running end-of-shift job...');
    try {
      await worker.runEndOfShiftJob(bot);
      await ctx.reply('✅ Daily job complete.');
    } catch (e) {
      await ctx.reply(`❌ Error: ${e.message}`);
    }
  });

  bot.command('force_weekly', async (ctx) => {
    const telegramId = String(ctx.from.id);
    if (!config.bot.adminTelegramIds.includes(telegramId)) return;
    await ctx.reply('⏳ Running weekly job...');
    try {
      await worker.runWeeklyJob(bot);
      await ctx.reply('✅ Weekly job complete.');
    } catch (e) {
      await ctx.reply(`❌ Error: ${e.message}`);
    }
  });

  // ─── Text messages (phone number entry) ──────────────────────────────────
  bot.on('text', async (ctx) => {
    const telegramId = String(ctx.from.id);
    const text = ctx.message.text.trim();

    // Skip if it's a command
    if (text.startsWith('/')) return;

    // If user is in setup flow
    if (pendingSetup.has(telegramId)) {
      await handlePhoneInput(ctx, telegramId, text, bot);
      return;
    }

    // If user is registered, just acknowledge
    const user = db.getUser(telegramId);
    if (user && user.rc_phone_number) {
      await ctx.reply(
        `ℹ️ You're already set up! I'm working in the background.\n\n` +
        `Use /status to see your current status or /help for more info.`
      );
    } else {
      // Re-enter setup
      pendingSetup.add(telegramId);
      await ctx.reply(
        `Please enter your RingCentral phone number to get started:\n` +
        `(Format: +1XXXXXXXXXX or 10-digit number)`
      );
    }
  });
}

async function handlePhoneInput(ctx, telegramId, phoneInput, bot) {
  // Validate and normalize phone number
  const cleaned = phoneInput.replace(/\D/g, '');
  let normalized;

  if (cleaned.length === 10) {
    normalized = `+1${cleaned}`;
  } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
    normalized = `+${cleaned}`;
  } else {
    await ctx.reply(
      `❌ Invalid phone number format.\n\n` +
      `Please enter a valid US phone number:\n` +
      `• 10 digits: \`3125551234\`\n` +
      `• With country code: \`+13125551234\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  pendingSetup.delete(telegramId);
  await ctx.reply(`⏳ Looking up your RingCentral extension for ${normalized}...`);

  // Find extension
  let extensionId = null;
  try {
    const extInfo = await rc.findExtensionByPhone(normalized);
    if (extInfo) {
      extensionId = extInfo.extensionId;
      logger.info(`Extension found for ${normalized}: ${extensionId}`);
    } else {
      logger.warn(`No extension found for ${normalized}, will use account-level log`);
    }
  } catch (err) {
    logger.error(`Extension lookup error: ${err.message}`);
  }

  // Save user
  db.upsertUser(telegramId, normalized, extensionId);

  await ctx.reply(
    `✅ *Setup Complete!*\n\n` +
    `📱 Phone: \`${normalized}\`\n` +
    `🔌 Extension: ${extensionId ? `\`${extensionId}\`` : 'Account-level monitoring'}\n\n` +
    `🎉 I'm now monitoring your calls!\n\n` +
    `*Schedule:*\n` +
    `• Calls checked every 30 minutes during shift\n` +
    `• Shift: 8:00 AM – 6:00 PM (Central Time)\n` +
    `• Daily report sent at end of shift\n` +
    `• Weekly report sent every Saturday\n\n` +
    `You don't need to do anything else — just focus on your calls! 📞`,
    { parse_mode: 'Markdown' }
  );

  // Run initial backfill in background
  const user = db.getUser(telegramId);
  if (user) {
    setImmediate(async () => {
      try {
        await ctx.reply(`🔄 Running initial sync (last ${config.bot.backfillDays} days)...`);
        const count = await worker.backfillUser(user, bot);
        if (count > 0) {
          await bot.telegram.sendMessage(
            telegramId,
            `📦 Found *${count}* recorded calls from the last ${config.bot.backfillDays} days.\nAnalysis will begin shortly during the next polling cycle.`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await bot.telegram.sendMessage(
            telegramId,
            `📭 No recorded calls found in the last ${config.bot.backfillDays} days. I'll start monitoring from now.`
          );
        }
      } catch (err) {
        logger.error(`Backfill error for ${telegramId}: ${err.message}`);
      }
    });
  }
}

module.exports = { registerHandlers };
