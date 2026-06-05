'use strict';

const cron = require('node-cron');
const config = require('../utils/config');
const logger = require('../utils/logger');
const timeUtils = require('../utils/time');
const worker = require('./worker');

let pollJob = null;
let shiftEndJob = null;

// Guards to prevent parallel execution
let pollRunning = false;
let endOfShiftRunning = false;
let weeklyRunning = false;

function startScheduler(bot) {
  logger.info('Starting scheduler...');

  // ─── Poll job: every 30 min during shift ─────────────────────────────────
  pollJob = cron.schedule(config.bot.pollCron, async () => {
    if (!timeUtils.isShiftActive()) {
      logger.debug('Poll skipped: outside shift hours');
      return;
    }
    if (pollRunning) {
      logger.warn('Poll already running, skipping tick');
      return;
    }
    pollRunning = true;
    try {
      await worker.runPollJob(bot);
    } catch (err) {
      logger.error(`Poll cron error: ${err.message}`);
    } finally {
      pollRunning = false;
    }
  }, { timezone: timeUtils.CT_ZONE });

  // ─── End-of-shift: exact cron "0 19 * * *" in CT timezone ───────────────
  // FIX: was polling every minute with isShiftEnd() check — unreliable.
  // Now uses a proper cron expression fired ONCE at exactly 18:00 CT.
  shiftEndJob = cron.schedule('0 18 * * *', async () => {
    if (endOfShiftRunning) {
      logger.warn('End-of-shift already running, skipping duplicate');
      return;
    }
    endOfShiftRunning = true;
    try {
      logger.info('18:00 CT — running end-of-shift job');
      await worker.runEndOfShiftJob(bot);

      // Saturday: run weekly report right after daily
      if (timeUtils.isSaturday()) {
        if (!weeklyRunning) {
          weeklyRunning = true;
          try {
            logger.info('Saturday 18:00 CT — running weekly summary job');
            await new Promise(r => setTimeout(r, 5000));
            await worker.runWeeklyJob(bot);
          } catch (err) {
            logger.error(`Weekly cron error: ${err.message}`);
          } finally {
            weeklyRunning = false;
          }
        }
      }
    } catch (err) {
      logger.error(`End-of-shift cron error: ${err.message}`);
    } finally {
      endOfShiftRunning = false;
    }
  }, { timezone: timeUtils.CT_ZONE });

  logger.info('Scheduler started:');
  logger.info(`  Poll:         ${config.bot.pollCron} CT (shift hours only)`);
  logger.info('  End-of-shift: 0 19 * * * CT (fires once at 18:00 CT)');
  logger.info('  Weekly:       after 18:00 CT every Saturday');
}

function stopScheduler() {
  if (pollJob)     { pollJob.stop();     pollJob = null; }
  if (shiftEndJob) { shiftEndJob.stop(); shiftEndJob = null; }
  logger.info('Scheduler stopped.');
}

module.exports = { startScheduler, stopScheduler };
