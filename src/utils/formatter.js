'use strict';

const dayjs = require('dayjs');

/**
 * Format a single call analysis into a Telegram message
 */
function formatCallReview(call, analysis) {
  const score = analysis.score ?? 0;
  const scoreEmoji = getScoreEmoji(score);
  const profanity = analysis.profanity_detected;

  let msg = `📞 *Call Review*\n`;
  msg += `🕐 ${formatTime(call.start_time)} | ⏱ ${formatDuration(call.durationSeconds)}\n`;
  msg += `📊 Score: *${score}/100* ${scoreEmoji}\n\n`;

  if (profanity && analysis.profanity_words && analysis.profanity_words.length > 0) {
    msg += `🚫 *Profanity Detected!*\n`;
    msg += `Words used: \`${analysis.profanity_words.join(', ')}\`\n\n`;
  }

  msg += `📋 *Manners:* ${analysis.manners_rating || 'N/A'}\n`;
  msg += `💬 *Communication:* ${analysis.communication_rating || 'N/A'}\n\n`;

  if (analysis.behavior_summary) {
    msg += `📝 *Summary:*\n${analysis.behavior_summary}\n\n`;
  }

  if (analysis.strengths && analysis.strengths !== 'None identified') {
    msg += `✅ *Strengths:*\n${analysis.strengths}\n\n`;
  }

  if (analysis.weaknesses && analysis.weaknesses !== 'None identified') {
    msg += `⚠️ *Needs Improvement:*\n${analysis.weaknesses}\n\n`;
  }

  if (analysis.advice) {
    msg += `💡 *Advice:*\n${analysis.advice}`;
  }

  return msg;
}

/**
 * Format daily shift summary message
 */
function formatDailySummary(date, result) {
  const score = result.overallScore;
  const scoreEmoji = score !== null ? getScoreEmoji(score) : '📊';

  let msg = `🏁 *End of Shift Report*\n`;
  msg += `📅 Date: ${date}\n`;
  msg += `📞 Calls Analyzed: ${result.totalCalls || 0}\n`;

  if (score !== null) {
    msg += `⭐ Overall Score: *${score}/100* ${scoreEmoji}\n`;
  }

  msg += `\n${result.summary}`;
  return msg;
}

/**
 * Format weekly summary message
 */
function formatWeeklySummary(weekStart, weekEnd, result) {
  const score = result.overallScore;
  const scoreEmoji = score !== null ? getScoreEmoji(score) : '📊';

  let msg = `📅 *Weekly Performance Report*\n`;
  msg += `🗓 Period: ${weekStart} → ${weekEnd}\n`;
  msg += `📆 Days Reviewed: ${result.totalDays || 0}\n`;

  if (score !== null) {
    msg += `🏆 Weekly Average: *${score}/100* ${scoreEmoji}\n`;
  }

  msg += `\n${result.summary}`;
  return msg;
}

function getScoreEmoji(score) {
  if (score >= 90) return '🌟';
  if (score >= 75) return '✅';
  if (score >= 60) return '🟡';
  if (score >= 40) return '🟠';
  return '🔴';
}

function formatTime(isoString) {
  if (!isoString) return 'Unknown time';
  return dayjs(isoString).format('HH:mm');
}

function formatDuration(seconds) {
  if (!seconds) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Split a long message into Telegram-safe chunks (max 4096 chars)
 */
function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let current = '';
  const lines = text.split('\n');
  for (const line of lines) {
    if ((current + '\n' + line).length > maxLen) {
      if (current) chunks.push(current.trim());
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

module.exports = {
  formatCallReview,
  formatDailySummary,
  formatWeeklySummary,
  splitMessage
};
