'use strict';

const dayjs = require('dayjs');

const CALL_TYPE_ICONS = {
  first_contact:    '🔵',
  warm_followup:    '🟡',
  pipeline_process: '🟠',
  active_checkin:   '🟢'
};

/**
 * Format a single call analysis into a Telegram message
 */
function formatCallReview(call, analysis) {
  const score     = analysis.score ?? 0;
  const emoji     = getScoreEmoji(score);
  const typeIcon  = CALL_TYPE_ICONS[analysis.call_type] || '📞';
  const typeLabel = analysis.call_type_label || callTypeLabel(analysis.call_type);

  let msg = `${typeIcon} *${typeLabel}*\n`;
  msg += `🕐 ${formatTime(call.start_time)} | ⏱ ${formatDuration(call.durationSeconds || call.duration_seconds)}\n`;
  msg += `📊 Score: *${score}/100* ${emoji}\n`;

  if (analysis.profanity_detected && analysis.profanity_words?.length) {
    msg += `\n🚫 *Profanity Detected:* \`${analysis.profanity_words.join(', ')}\`\n`;
  }

  msg += `\n📋 Manners: *${analysis.manners_rating || 'N/A'}*\n`;
  msg += `💬 Communication: *${analysis.communication_rating || 'N/A'}*\n`;
  msg += `🎙 Tone: *${analysis.tone_rating || 'N/A'}*\n`;
  msg += `👂 Listening: *${analysis.listening_rating || 'N/A'}*\n`;
  msg += `⚡ Energy: *${analysis.energy_rating || 'N/A'}*\n`;

  const purposeIcon = analysis.call_purpose_clear ? '✅' : '❌';
  const stepIcon    = analysis.next_step_given    ? '✅' : '❌';
  msg += `\n${purposeIcon} Purpose stated clearly\n`;
  msg += `${stepIcon} Next step given at end\n`;

  if (analysis.criteria_violations?.length) {
    msg += `\n⚠️ *Standards violated:*\n`;
    analysis.criteria_violations.slice(0, 3).forEach(v => {
      msg += `  • ${v}\n`;
    });
  }

  if (analysis.behavior_summary) {
    msg += `\n📝 *Summary:*\n${analysis.behavior_summary}\n`;
  }

  if (analysis.strengths && analysis.strengths !== 'N/A' && analysis.strengths !== 'None identified') {
    msg += `\n✅ *Strengths:*\n${analysis.strengths}\n`;
  }

  if (analysis.weaknesses && analysis.weaknesses !== 'N/A' && analysis.weaknesses !== 'None identified') {
    msg += `\n⚠️ *Needs Improvement:*\n${analysis.weaknesses}\n`;
  }

  if (analysis.advice && analysis.advice !== 'N/A') {
    msg += `\n💡 *Advice:*\n${analysis.advice}`;
  }

  return msg;
}

/**
 * Format daily shift summary message
 */
function formatDailySummary(date, result) {
  const score = result.overallScore;
  const emoji = score !== null ? getScoreEmoji(score) : '📊';

  let msg = `🏁 *End of Shift Report – ${date}*\n`;
  msg += `📞 Calls Analyzed: *${result.totalCalls || 0}*\n`;

  if (score !== null) {
    msg += `⭐ Average Score: *${score}/100* ${emoji}\n`;
  }

  msg += `\n${result.summary}`;
  return msg;
}

/**
 * Format weekly summary message
 */
function formatWeeklySummary(weekStart, weekEnd, result) {
  const score = result.overallScore;
  const emoji = score !== null ? getScoreEmoji(score) : '📊';

  let msg = `📅 *Weekly Performance Report*\n`;
  msg += `🗓 Period: ${weekStart} → ${weekEnd}\n`;
  msg += `📆 Days Reviewed: *${result.totalDays || 0}*\n`;

  if (score !== null) {
    msg += `🏆 Weekly Average: *${score}/100* ${emoji}\n`;
  }

  msg += `\n${result.summary}`;
  return msg;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getScoreEmoji(score) {
  if (score >= 90) return '🌟';
  if (score >= 75) return '✅';
  if (score >= 60) return '🟡';
  if (score >= 40) return '🟠';
  return '🔴';
}

function callTypeLabel(type) {
  const labels = {
    first_contact:    'First Contact Call',
    warm_followup:    'Warm Follow-Up Call',
    pipeline_process: 'Pipeline / Process Call',
    active_checkin:   'Active Driver Check-In'
  };
  return labels[type] || 'Call Review';
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
  splitMessage,
  getScoreEmoji
};
