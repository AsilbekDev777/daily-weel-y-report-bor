'use strict';

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const CT_ZONE = 'America/Chicago';
const SHIFT_START_HOUR = 8;  // 8:00 AM CT
const SHIFT_END_HOUR = 18;   // 6:00 PM CT

function nowCT() {
  return dayjs().tz(CT_ZONE);
}

function isShiftActive() {
  const h = nowCT().hour();
  return h >= SHIFT_START_HOUR && h < SHIFT_END_HOUR;
}

// REMOVED isShiftEnd() — was the root cause of the missing end-of-shift report.
// The scheduler now uses cron expression "0 18 * * *" with timezone: CT_ZONE
// which fires exactly once at 18:00 CT. No polling every minute needed.

function isSaturday() {
  return nowCT().day() === 6;
}

function todayDateCT() {
  return nowCT().format('YYYY-MM-DD');
}

function todayShiftRange() {
  const today = nowCT().startOf('day');
  const shiftStart = today.hour(SHIFT_START_HOUR).minute(0).second(0);
  const shiftEnd   = today.hour(SHIFT_END_HOUR).minute(0).second(0);
  return {
    dateFrom: shiftStart.toDate().toISOString(),
    dateTo:   shiftEnd.toDate().toISOString()
  };
}

function lastNDaysRange(n) {
  const now = nowCT();
  return {
    dateFrom: now.subtract(n, 'day').startOf('day').toDate().toISOString(),
    dateTo:   now.toDate().toISOString()
  };
}

function lookbackRange(minutes) {
  const now = new Date();
  return {
    dateFrom: new Date(now.getTime() - minutes * 60 * 1000).toISOString(),
    dateTo:   now.toISOString()
  };
}

function lastWeekWorkingRange() {
  const sat = nowCT();
  return {
    weekStart: sat.subtract(5, 'day').format('YYYY-MM-DD'), // Monday
    weekEnd:   sat.format('YYYY-MM-DD')                     // Saturday
  };
}

function formatDateCT(isoString) {
  return dayjs(isoString).tz(CT_ZONE).format('YYYY-MM-DD HH:mm');
}

/**
 * Debug helper — logs current time in CT and shift status
 */
function logCurrentShiftStatus(logger) {
  const now = nowCT();
  logger.info(`Current time CT: ${now.format('YYYY-MM-DD HH:mm:ss')} | Shift active: ${isShiftActive()} | Saturday: ${isSaturday()}`);
}

module.exports = {
  nowCT,
  isShiftActive,
  isSaturday,
  todayDateCT,
  todayShiftRange,
  lastNDaysRange,
  lookbackRange,
  lastWeekWorkingRange,
  formatDateCT,
  logCurrentShiftStatus,
  CT_ZONE,
  SHIFT_START_HOUR,
  SHIFT_END_HOUR
};
