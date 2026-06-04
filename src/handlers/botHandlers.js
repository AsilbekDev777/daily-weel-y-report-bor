'use strict';

const db = require('../db/database');
const rc = require('../services/ringcentral');
const worker = require('../services/worker');
const config = require('../utils/config');
const logger = require('../utils/logger');
const timeUtils = require('../utils/time');

// Users in initial setup (no phone yet)
const pendingSetup = new Set();

// Users in re-auth flow (changing existing phone)
const pendingReauth = new Set();

function registerHandlers(bot) {

  // ─── /start ───────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const telegramId = String(ctx.from.id);
    const firstName  = ctx.from.first_name || 'there';

    db.upsertUser(telegramId);
    const user = db.getUser(telegramId);

    if (user && user.rc_phone_number) {
      await ctx.reply(
        `👋 Welcome back, *${firstName}*!\n\n` +
        `✅ Registered number: \`${user.rc_phone_number}\`\n\n` +
        `I'm monitoring your calls during shift hours (9:00 AM – 7:00 PM CT).\n\n` +
        `📊 Daily reports are sent at end of shift.\n` +
        `📅 Weekly reports are sent every Saturday.\n\n` +
        `_Wrong number? Use /changephone_`,
        { parse_mode: 'Markdown' }
      );
    } else {
      pendingSetup.add(telegramId);
      await ctx.reply(
        `👋 Hello, *${firstName}*! Welcome to the *Call Quality Review Bot*.\n\n` +
        `I will:\n` +
        `• 🎙 Monitor your RingCentral calls during shift (9 AM – 7 PM CT)\n` +
        `• 📝 Transcribe and analyze each call with AI\n` +
        `• ⭐ Score your performance (0–100) and give advice\n` +
        `• 📊 Send a daily summary at end of shift\n` +
        `• 📅 Send a weekly report every Saturday\n\n` +
        `To get started, please enter your *RingCentral phone number*:\n` +
        `_(Format: +1XXXXXXXXXX or 10-digit number)_`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ─── /changephone ─────────────────────────────────────────────────────────
  bot.command('changephone', async (ctx) => {
    const telegramId = String(ctx.from.id);
    const user = db.getUser(telegramId);

    // Remove from any existing flow first
    pendingSetup.delete(telegramId);
    pendingReauth.delete(telegramId);

    if (user && user.rc_phone_number) {
      pendingReauth.add(telegramId);
      await ctx.reply(
        `📱 *Change Phone Number*\n\n` +
        `Current number: \`${user.rc_phone_number}\`\n` +
        `Extension: \`${user.rc_extension_id || 'account-level'}\`\n\n` +
        `Please enter your *new RingCentral phone number*:\n` +
        `_(Format: +1XXXXXXXXXX or 10-digit number)_\n\n` +
        `Send /cancel to abort.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      // Not registered yet — go to normal setup
      pendingSetup.add(telegramId);
      await ctx.reply(
        `You are not registered yet. Please enter your RingCentral phone number:\n` +
        `_(Format: +1XXXXXXXXXX or 10-digit number)_`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  // ─── /cancel ──────────────────────────────────────────────────────────────
  bot.command('cancel', async (ctx) => {
    const telegramId = String(ctx.from.id);
    const wasInFlow = pendingReauth.has(telegramId) || pendingSetup.has(telegramId);

    pendingReauth.delete(telegramId);
    pendingSetup.delete(telegramId);

    if (wasInFlow) {
      await ctx.reply('✅ Cancelled. Your phone number was not changed.', { parse_mode: 'Markdown' });
    } else {
      await ctx.reply('Nothing to cancel.', { parse_mode: 'Markdown' });
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
    const lastSync    = db.getLastSyncedAt(telegramId);

    await ctx.reply(
      `📊 *Your Status*\n\n` +
      `📱 Phone: \`${user.rc_phone_number}\`\n` +
      `🔌 Extension: \`${user.rc_extension_id || 'account-level'}\`\n` +
      `🕐 Shift: ${shiftActive ? '🟢 Active (9 AM – 7 PM CT)' : '🔴 Inactive'}\n` +
      `🔄 Last Sync: ${lastSync ? new Date(lastSync).toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' CT' : 'Never'}\n` +
      `📅 Today (CT): ${timeUtils.todayDateCT()}\n\n` +
      `_To change your number: /changephone_`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── /help ────────────────────────────────────────────────────────────────
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `🤖 *Call Quality Review Bot – Help*\n\n` +
      `*Commands:*\n` +
      `/start – Register or check your setup\n` +
      `/changephone – Change your RingCentral phone number\n` +
      `/cancel – Cancel phone number change\n` +
      `/status – View your current status\n` +
      `/help – Show this message\n\n` +
      `*How it works:*\n` +
      `1️⃣ Register with your RingCentral phone number\n` +
      `2️⃣ During shift (9 AM–7 PM CT), calls are polled every 30 min\n` +
      `3️⃣ Each recorded call is transcribed and analyzed by AI\n` +
      `4️⃣ At 7 PM you receive an end-of-shift summary report\n` +
      `5️⃣ Every Saturday, a weekly performance report is sent\n\n` +
      `*Shift Hours:* 9:00 AM – 7:00 PM (Central Time)`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── Admin commands ───────────────────────────────────────────────────────
  bot.command('admin', async (ctx) => {
    const telegramId = String(ctx.from.id);
    if (!config.bot.adminTelegramIds.includes(telegramId)) {
      return ctx.reply('⛔ You are not authorized.');
    }

    const users    = db.getAllActiveUsers();
    const userList = users.length > 0
      ? users.map(u => `• \`${u.telegram_id}\` – ${u.rc_phone_number}`).join('\n')
      : 'No active users';

    await ctx.reply(
      `🔧 *Admin Panel*\n\n` +
      `👥 Active Users (${users.length}):\n${userList}\n\n` +
      `*Commands:*\n` +
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

  // ─── Text messages ────────────────────────────────────────────────────────
  bot.on('text', async (ctx) => {
    const telegramId = String(ctx.from.id);
    const text       = ctx.message.text.trim();

    if (text.startsWith('/')) return;

    // Re-auth flow (changing phone)
    if (pendingReauth.has(telegramId)) {
      await handleReauth(ctx, telegramId, text, bot);
      return;
    }

    // Initial setup flow
    if (pendingSetup.has(telegramId)) {
      await handlePhoneInput(ctx, telegramId, text, bot, false);
      return;
    }

    // Registered user sent random text
    const user = db.getUser(telegramId);
    if (user && user.rc_phone_number) {
      await ctx.reply(
        `ℹ️ I'm running in the background, monitoring your calls.\n\n` +
        `Use /status to check your status.\n` +
        `Use /changephone to update your number.\n` +
        `Use /help for all commands.`
      );
    } else {
      pendingSetup.add(telegramId);
      await ctx.reply(
        `Please enter your RingCentral phone number to get started:\n` +
        `_(Format: +1XXXXXXXXXX or 10-digit number)_`,
        { parse_mode: 'Markdown' }
      );
    }
  });
}

// ─── Handle re-auth (phone change) ────────────────────────────────────────────

async function handleReauth(ctx, telegramId, phoneInput, bot) {
  const normalized = normalizePhone(phoneInput);
  if (!normalized) {
    await ctx.reply(
      `❌ Invalid phone number format.\n\n` +
      `Please enter a valid US number:\n` +
      `• 10 digits: \`3125551234\`\n` +
      `• With country code: \`+13125551234\`\n\n` +
      `Send /cancel to abort.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const oldUser = db.getUser(telegramId);
  const oldPhone = oldUser?.rc_phone_number;

  // Same number?
  if (oldPhone === normalized) {
    pendingReauth.delete(telegramId);
    await ctx.reply(
      `ℹ️ This is the same number already registered: \`${normalized}\`\n\n` +
      `No changes were made.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  pendingReauth.delete(telegramId);
  await ctx.reply(`⏳ Looking up extension for ${normalized}...`);

  // Find new extension
  let extensionId = null;
  try {
    const extInfo = await rc.findExtensionByPhone(normalized);
    if (extInfo) {
      extensionId = extInfo.extensionId;
      logger.info(`Re-auth: extension found for ${normalized}: ${extensionId}`);
    } else {
      logger.warn(`Re-auth: no extension found for ${normalized}, using account-level`);
    }
  } catch (err) {
    logger.error(`Re-auth extension lookup error: ${err.message}`);
  }

  // Clear old calls tied to the old number/extension before switching
  try {
    const today   = timeUtils.todayDateCT();
    const deleted = db.deleteCallsForDate(telegramId, today);
    if (deleted > 0) {
      logger.info(`Re-auth: cleared ${deleted} today's calls for old number ${oldPhone}`);
    }
    // Also clear any unanalyzed calls from previous days
    db.deleteCallsOlderThan(0); // delete everything
    logger.info(`Re-auth: cleared all old call records for ${telegramId}`);
  } catch (cleanErr) {
    logger.warn(`Re-auth cleanup error: ${cleanErr.message}`);
  }

  // Save new number
  db.upsertUser(telegramId, normalized, extensionId);

  await ctx.reply(
    `✅ *Phone Number Updated!*\n\n` +
    `📱 Old number: \`${oldPhone || 'none'}\`\n` +
    `📱 New number: \`${normalized}\`\n` +
    `🔌 Extension: ${extensionId ? `\`${extensionId}\`` : 'Account-level monitoring'}\n\n` +
    `🧹 All previous call records cleared.\n\n` +
    `I'm now monitoring calls for your new number.\n` +
    `Shift hours: 9:00 AM – 7:00 PM CT 📞`,
    { parse_mode: 'Markdown' }
  );

  // Backfill with new number
  const updatedUser = db.getUser(telegramId);
  if (updatedUser) {
    setImmediate(async () => {
      try {
        const count = await worker.backfillUser(updatedUser, bot);
        if (count > 0) {
          await bot.telegram.sendMessage(
            telegramId,
            `📦 Found *${count}* recorded calls for the new number (last ${config.bot.backfillDays} days).\nAnalysis will begin in the next polling cycle.`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (err) {
        logger.error(`Re-auth backfill error: ${err.message}`);
      }
    });
  }
}

// ─── Handle initial phone input ───────────────────────────────────────────────

async function handlePhoneInput(ctx, telegramId, phoneInput, bot) {
  const normalized = normalizePhone(phoneInput);
  if (!normalized) {
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

  let extensionId = null;
  try {
    const extInfo = await rc.findExtensionByPhone(normalized);
    if (extInfo) {
      extensionId = extInfo.extensionId;
      logger.info(`Extension found for ${normalized}: ${extensionId}`);
    } else {
      logger.warn(`No extension found for ${normalized}, using account-level`);
    }
  } catch (err) {
    logger.error(`Extension lookup error: ${err.message}`);
  }

  db.upsertUser(telegramId, normalized, extensionId);

  await ctx.reply(
    `✅ *Setup Complete!*\n\n` +
    `📱 Phone: \`${normalized}\`\n` +
    `🔌 Extension: ${extensionId ? `\`${extensionId}\`` : 'Account-level monitoring'}\n\n` +
    `🎉 I'm now monitoring your calls!\n\n` +
    `*Schedule:*\n` +
    `• Calls checked every 30 min during shift\n` +
    `• Shift: 9:00 AM – 7:00 PM (Central Time)\n` +
    `• Daily report at end of shift\n` +
    `• Weekly report every Saturday\n\n` +
    `_Wrong number? Use /changephone_`,
    { parse_mode: 'Markdown' }
  );

  const user = db.getUser(telegramId);
  if (user) {
    setImmediate(async () => {
      try {
        await ctx.reply(`🔄 Running initial sync (last ${config.bot.backfillDays} days)...`);
        const count = await worker.backfillUser(user, bot);
        await bot.telegram.sendMessage(
          telegramId,
          count > 0
            ? `📦 Found *${count}* recorded calls from the last ${config.bot.backfillDays} days.\nAnalysis begins in the next polling cycle.`
            : `📭 No recorded calls found in the last ${config.bot.backfillDays} days. Monitoring starts now.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        logger.error(`Backfill error for ${telegramId}: ${err.message}`);
      }
    });
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function normalizePhone(input) {
  const cleaned = input.replace(/\D/g, '');
  if (cleaned.length === 10)                          return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  return null;
}

module.exports = { registerHandlers };
