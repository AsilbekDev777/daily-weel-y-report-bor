'use strict';

require('dotenv').config();

const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    handlerTimeoutMs: parseInt(process.env.TELEGRAM_HANDLER_TIMEOUT_MS) || 300000
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    analysisModel: process.env.OPENAI_ANALYSIS_MODEL || 'gpt-5.5',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-transcribe',
    requestTimeoutMs: parseInt(process.env.OPENAI_REQUEST_TIMEOUT_MS) || 300000,
    delayMs: parseInt(process.env.OPENAI_DELAY_MS) || 5000
  },
  ringcentral: {
    serverUrl: process.env.RC_SERVER_URL || 'https://platform.ringcentral.com',
    clientId: process.env.RC_CLIENT_ID,
    clientSecret: process.env.RC_CLIENT_SECRET,
    jwt: process.env.RC_JWT,
    callLogLevel: process.env.RC_CALL_LOG_LEVEL || 'account',
    requestTimeoutMs: parseInt(process.env.RC_REQUEST_TIMEOUT_MS) || 300000,
    requestsPerMinute: parseInt(process.env.RC_REQUESTS_PER_MINUTE) || 4,
    perPage: parseInt(process.env.RC_PER_PAGE) || 100,
    maxPages: parseInt(process.env.RC_MAX_PAGES) || 10
  },
  bot: {
    pollCron: process.env.POLL_CRON || '*/30 * * * *',
    lookbackMinutes: parseInt(process.env.LOOKBACK_MINUTES) || 45,
    backfillDays: parseInt(process.env.BACKFILL_DAYS) || 7,
    last30DaysSyncDays: parseInt(process.env.LAST_30_DAYS_SYNC_DAYS) || 30,
    debugMode: process.env.DEBUG_MODE === 'true',
    adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    databasePath: process.env.DATABASE_PATH || './data/bot.sqlite',
    downloadDir: process.env.DOWNLOAD_DIR || './data/recordings',
    maxAudioMb: parseInt(process.env.MAX_AUDIO_MB) || 25,
    maxAnalyzePerSync: parseInt(process.env.MAX_ANALYZE_PER_SYNC) || 4,
    minCallDurationSeconds: parseInt(process.env.MIN_CALL_DURATION_SECONDS) || 60
  },
  // Shift hours in Central Time
  shift: {
    startHour: 9,   // 9:00 AM CT
    endHour: 19,    // 7:00 PM CT
    timezone: 'America/Chicago'
  }
};

module.exports = config;
