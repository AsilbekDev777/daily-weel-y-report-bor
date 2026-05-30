'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../utils/config');
const logger = require('../utils/logger');

// ─── Token Cache ──────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Authenticate via JWT grant and return access token
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  logger.info('RingCentral: obtaining new access token via JWT...');

  const credentials = Buffer.from(
    `${config.ringcentral.clientId}:${config.ringcentral.clientSecret}`
  ).toString('base64');

  try {
    const resp = await axios({
      method: 'POST',
      url: `${config.ringcentral.serverUrl}/restapi/oauth/token`,
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      data: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${config.ringcentral.jwt}`,
      timeout: config.ringcentral.requestTimeoutMs
    });

    cachedToken = resp.data.access_token;
    // Expire 5 min early
    tokenExpiresAt = Date.now() + (resp.data.expires_in - 300) * 1000;
    logger.info('RingCentral: authenticated successfully');
    return cachedToken;
  } catch (err) {
    const msg = err.response?.data?.error_description || err.message;
    logger.error(`RingCentral auth failed: ${msg}`);
    throw new Error(`RC auth error: ${msg}`);
  }
}

/**
 * Make an authenticated GET request to RingCentral REST API
 */
async function rcGet(endpoint, params = {}) {
  const token = await getAccessToken();
  const url = endpoint.startsWith('http')
    ? endpoint
    : `${config.ringcentral.serverUrl}${endpoint}`;

  try {
    const resp = await axios({
      method: 'GET',
      url,
      params,
      headers: { Authorization: `Bearer ${token}` },
      timeout: config.ringcentral.requestTimeoutMs
    });
    return resp.data;
  } catch (err) {
    // Token may have expired mid-session
    if (err.response?.status === 401) {
      cachedToken = null;
      tokenExpiresAt = 0;
      logger.warn('RC 401 – clearing token cache, will retry next call');
    }
    throw err;
  }
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────
const RC_RPM = config.ringcentral.requestsPerMinute;
const RC_DELAY_MS = Math.ceil((60 * 1000) / RC_RPM);
let lastRcRequestAt = 0;

async function rateLimitedRcGet(endpoint, params) {
  const now = Date.now();
  const elapsed = now - lastRcRequestAt;
  if (elapsed < RC_DELAY_MS) {
    await sleep(RC_DELAY_MS - elapsed);
  }
  lastRcRequestAt = Date.now();
  return rcGet(endpoint, params);
}

/**
 * Find extension ID by phone number
 */
async function findExtensionByPhone(phoneNumber) {
  try {
    const data = await rateLimitedRcGet('/restapi/v1.0/account/~/extension', {
      perPage: 200,
      status: 'Enabled'
    });

    const normalize = (p) => p ? p.replace(/\D/g, '').slice(-10) : '';
    const target = normalize(phoneNumber);

    for (const ext of (data.records || [])) {
      const contact = ext.contact || {};
      const candidates = [
        contact.phoneNumber,
        contact.mobilePhone,
        contact.businessPhone
      ].filter(Boolean);

      for (const num of candidates) {
        if (normalize(num) === target) {
          logger.info(`Found extension ${ext.id} (ext ${ext.extensionNumber}) for ${phoneNumber}`);
          return { extensionId: String(ext.id), extensionNumber: ext.extensionNumber };
        }
      }
    }
    logger.warn(`No extension found for ${phoneNumber}`);
    return null;
  } catch (err) {
    logger.error(`findExtensionByPhone error: ${err.message}`);
    return null;
  }
}

/**
 * Fetch call log records with recordings in a date range
 */
async function fetchCallLogs(dateFrom, dateTo, extensionId = null) {
  const allCalls = [];
  const perPage = config.ringcentral.perPage;
  const maxPages = config.ringcentral.maxPages;

  for (let page = 1; page <= maxPages; page++) {
    const params = {
      dateFrom,
      dateTo,
      perPage,
      page,
      withRecording: true,
      type: 'Voice',
      view: 'Detailed'
    };

    const endpoint = extensionId
      ? `/restapi/v1.0/account/~/extension/${extensionId}/call-log`
      : '/restapi/v1.0/account/~/call-log';

    try {
      const data = await rateLimitedRcGet(endpoint, params);
      const records = data.records || [];
      logger.debug(`fetchCallLogs page ${page}: ${records.length} records`);
      allCalls.push(...records);

      const nav = data.navigation || {};
      if (records.length < perPage || !nav.nextPage) break;
    } catch (err) {
      logger.error(`fetchCallLogs page ${page} error: ${err.message}`);
      break;
    }
  }

  logger.info(`fetchCallLogs total: ${allCalls.length} calls`);
  return allCalls;
}

/**
 * Download a recording to disk, return local file path or null
 */
async function downloadRecording(rcCallId, recordingUrl) {
  const downloadDir = path.resolve(config.bot.downloadDir);
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const filePath = path.join(downloadDir, `${rcCallId}.mp3`);
  if (fs.existsSync(filePath)) {
    logger.debug(`Recording already cached: ${filePath}`);
    return filePath;
  }

  try {
    const token = await getAccessToken();
    logger.info(`Downloading recording ${rcCallId}...`);

    const response = await axios({
      method: 'GET',
      url: recordingUrl,
      responseType: 'stream',
      timeout: config.ringcentral.requestTimeoutMs,
      headers: { Authorization: `Bearer ${token}` }
    });

    // Pre-check content-length
    const contentLength = parseInt(response.headers['content-length'] || '0');
    if (contentLength > config.bot.maxAudioMb * 1024 * 1024) {
      logger.warn(`Recording too large (${(contentLength / 1048576).toFixed(1)}MB), skipping`);
      return null;
    }

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const size = fs.statSync(filePath).size;
    const sizeMb = size / 1048576;
    if (sizeMb > config.bot.maxAudioMb) {
      fs.unlinkSync(filePath);
      logger.warn(`File too large after download (${sizeMb.toFixed(1)}MB), deleted`);
      return null;
    }

    logger.info(`Saved recording: ${filePath} (${sizeMb.toFixed(2)}MB)`);
    return filePath;
  } catch (err) {
    logger.error(`downloadRecording ${rcCallId}: ${err.message}`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return null;
  }
}

/**
 * Parse a raw RC call record into our DB format
 */
function parseCallRecord(record, telegramId, extensionId) {
  const recording = record.recording;
  const recordingUrl = recording?.contentUri || null;

  return {
    rcCallId: record.id,
    telegramId,
    extensionId: extensionId || null,
    phoneNumber: record.from?.phoneNumber || record.to?.phoneNumber || null,
    direction: record.direction || null,
    durationSeconds: record.duration || 0,
    startTime: record.startTime || null,
    endTime: record.startTime
      ? new Date(new Date(record.startTime).getTime() + (record.duration || 0) * 1000).toISOString()
      : null,
    recordingUrl
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  getAccessToken,
  findExtensionByPhone,
  fetchCallLogs,
  downloadRecording,
  parseCallRecord
};
