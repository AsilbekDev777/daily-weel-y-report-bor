'use strict';

const OpenAI = require('openai');
const fs = require('fs');
const config = require('../utils/config');
const logger = require('../utils/logger');

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
  timeout: config.openai.requestTimeoutMs
});

/**
 * Transcribe an audio file using Whisper
 */
async function transcribeAudio(filePath) {
  logger.info(`Transcribing: ${filePath}`);
  try {
    const fileStream = fs.createReadStream(filePath);
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: config.openai.transcriptionModel,
      language: 'en',
      response_format: 'text'
    });

    const text = typeof response === 'string' ? response : response.text || '';
    logger.info(`Transcription done (${text.length} chars)`);
    return text;
  } catch (err) {
    logger.error(`transcribeAudio error: ${err.message}`);
    throw err;
  }
}

/**
 * Analyze a single call transcription
 * Returns { score, profanity, profanityWords, manners, behavior, advice, summary }
 */
async function analyzeCall(transcription, callMeta = {}) {
  logger.info('Analyzing call transcription with GPT...');

  const systemPrompt = `You are a professional call quality analyst. Your task is to evaluate a customer service call transcript.

Analyze the following aspects:
1. **Profanity** – Did the agent use any profanity, swear words, or inappropriate language? List exact words if found.
2. **Manners** – Was the agent polite, respectful, and professional?
3. **Communication** – Was the agent clear, concise, and helpful?
4. **Overall behavior** – How did the agent handle the interaction overall?

Respond ONLY with a valid JSON object (no markdown, no explanation outside JSON) in this exact format:
{
  "score": <integer 0-100>,
  "profanity_detected": <true|false>,
  "profanity_words": [<list of exact profane words found, empty array if none>],
  "manners_rating": "<Excellent|Good|Fair|Poor>",
  "communication_rating": "<Excellent|Good|Fair|Poor>",
  "behavior_summary": "<2-3 sentence summary of agent behavior>",
  "strengths": "<what the agent did well>",
  "weaknesses": "<what needs improvement, or 'None identified'>",
  "advice": "<specific actionable advice for improvement>",
  "short_review": "<1-2 sentence overall review>"
}

Scoring guide:
- 90-100: Excellent – professional, polite, effective
- 75-89: Good – mostly professional with minor issues
- 60-74: Fair – acceptable but needs improvement
- 40-59: Poor – significant issues in communication or behavior
- 0-39: Unacceptable – serious violations (profanity, rudeness, etc.)

If profanity is detected, score must be below 60 regardless of other factors.`;

  const userMessage = `Call metadata:
- Direction: ${callMeta.direction || 'Unknown'}
- Duration: ${callMeta.durationSeconds || 0} seconds
- Date: ${callMeta.startTime || 'Unknown'}

Call transcript:
"""
${transcription}
"""

Analyze this call and return the JSON evaluation.`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openai.analysisModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 800
    });

    const raw = response.choices[0]?.message?.content || '{}';
    let parsed;
    try {
      // Strip any accidental markdown code fences
      const cleaned = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      logger.error(`Failed to parse GPT analysis JSON: ${raw}`);
      parsed = {
        score: 50,
        profanity_detected: false,
        profanity_words: [],
        manners_rating: 'Fair',
        communication_rating: 'Fair',
        behavior_summary: 'Analysis could not be fully parsed.',
        strengths: 'Unable to determine',
        weaknesses: 'Unable to determine',
        advice: 'Please review the transcript manually.',
        short_review: 'Automated analysis encountered an issue.'
      };
    }

    logger.info(`Call analysis complete. Score: ${parsed.score}`);
    return parsed;
  } catch (err) {
    logger.error(`analyzeCall error: ${err.message}`);
    throw err;
  }
}

/**
 * Generate a daily shift summary from all call reviews
 */
async function generateDailySummary(callReviews, shiftDate) {
  logger.info(`Generating daily summary for ${shiftDate} (${callReviews.length} calls)`);

  if (callReviews.length === 0) {
    return {
      summary: 'No calls were analyzed during this shift.',
      overallScore: null,
      recommendation: 'No data available for this shift.'
    };
  }

  const reviewsText = callReviews.map((r, i) => {
    const a = r.analysis || {};
    return `Call ${i + 1} (${r.direction || 'Unknown'}, ${r.durationSeconds || 0}s):
  Score: ${a.score ?? 'N/A'}
  Profanity: ${a.profanity_detected ? 'Yes – ' + (a.profanity_words || []).join(', ') : 'No'}
  Manners: ${a.manners_rating || 'N/A'}
  Communication: ${a.communication_rating || 'N/A'}
  Review: ${a.short_review || 'N/A'}
  Advice: ${a.advice || 'N/A'}`;
  }).join('\n\n');

  const scores = callReviews
    .map(r => r.analysis?.score)
    .filter(s => typeof s === 'number');
  const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  const systemPrompt = `You are a professional call center performance coach. Based on individual call reviews for a work shift, write a comprehensive end-of-shift performance summary for the agent. Be constructive, specific, and encouraging. Write in English.`;

  const userMessage = `Shift Date: ${shiftDate}
Total Calls Analyzed: ${callReviews.length}
Average Score: ${avgScore ?? 'N/A'}/100

Individual Call Reviews:
${reviewsText}

Write a comprehensive shift summary that includes:
1. Overall performance assessment
2. Key strengths demonstrated during the shift
3. Areas needing improvement
4. Specific action items for the next shift
5. Encouraging closing remark

Keep it professional, motivating, and practical. Use clear sections.`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openai.analysisModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.5,
      max_tokens: 1200
    });

    const summaryText = response.choices[0]?.message?.content || 'Summary generation failed.';
    logger.info('Daily summary generated successfully');
    return {
      summary: summaryText,
      overallScore: avgScore,
      totalCalls: callReviews.length
    };
  } catch (err) {
    logger.error(`generateDailySummary error: ${err.message}`);
    throw err;
  }
}

/**
 * Generate a weekly summary from all daily reviews
 */
async function generateWeeklySummary(dailyReviews, weekStart, weekEnd) {
  logger.info(`Generating weekly summary for ${weekStart} to ${weekEnd}`);

  if (dailyReviews.length === 0) {
    return {
      summary: 'No data available for this week.',
      overallScore: null
    };
  }

  const reviewsText = dailyReviews.map(r => {
    return `${r.review_date} (${r.analyzed_calls} calls analyzed, avg score: ${r.avg_score ?? 'N/A'}):
${r.review_text}
---`;
  }).join('\n\n');

  const avgScore = dailyReviews
    .filter(r => r.avg_score !== null)
    .reduce((sum, r, _, arr) => sum + r.avg_score / arr.length, 0);

  const systemPrompt = `You are a professional call center performance coach writing a weekly performance report for an agent. Synthesize the daily reviews into actionable insights and motivating guidance. Write in English.`;

  const userMessage = `Weekly Performance Report
Period: ${weekStart} to ${weekEnd}
Working Days Reviewed: ${dailyReviews.length}
Overall Weekly Average Score: ${avgScore ? Math.round(avgScore) : 'N/A'}/100

Daily Summaries:
${reviewsText}

Generate a comprehensive WEEKLY performance report that includes:
1. Week-at-a-Glance: overall performance trend
2. Consistent Strengths: what the agent did well all week
3. Recurring Issues: patterns that appeared across multiple days
4. Most Improved Day / Best Performance
5. Focus Areas for Next Week: top 3 specific goals
6. Weekly Score & Rating (Poor / Needs Improvement / Good / Excellent)
7. Motivational closing message

Make it structured, thorough, and encouraging.`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openai.analysisModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.5,
      max_tokens: 1800
    });

    const summaryText = response.choices[0]?.message?.content || 'Weekly summary generation failed.';
    logger.info('Weekly summary generated');
    return {
      summary: summaryText,
      overallScore: avgScore ? Math.round(avgScore) : null,
      totalDays: dailyReviews.length
    };
  } catch (err) {
    logger.error(`generateWeeklySummary error: ${err.message}`);
    throw err;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  transcribeAudio,
  analyzeCall,
  generateDailySummary,
  generateWeeklySummary,
  sleep
};
