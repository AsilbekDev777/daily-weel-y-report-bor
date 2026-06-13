'use strict';

const OpenAI = require('openai');
const fs = require('fs');
const config = require('../utils/config');
const logger = require('../utils/logger');
const { CALL_CRITERIA, FOLLOWUP_CRITERIA } = require('../config/call_criteria');

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
  timeout: config.openai.requestTimeoutMs
});

const WORDS_SHORT  = 2500;
const WORDS_MEDIUM = 6000;

// ─── Transcription ─────────────────────────────────────────────────────────

async function transcribeAudio(filePath) {
  logger.info(`Transcribing: ${filePath}`);
  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: config.openai.transcriptionModel,
      language: 'en',
      response_format: 'text'
    });
    const text = typeof response === 'string' ? response : (response.text || '');
    logger.info(`Transcription done: ${text.trim().split(/\s+/).length} words`);
    return text;
  } catch (err) {
    logger.error(`transcribeAudio: ${err.message}`);
    throw err;
  }
}

// ─── Transcript compression for long calls ─────────────────────────────────

async function compressTranscript(transcription) {
  const words = transcription.trim().split(/\s+/).length;
  logger.info(`Transcript: ${words} words`);

  if (words <= WORDS_SHORT) {
    return { text: transcription, compressed: false, words };
  }

  logger.info(`Long call (${words} words) — extracting quality-relevant excerpts...`);
  const isDeep = words > WORDS_MEDIUM;

  const prompt = isDeep
    ? `Extract VERBATIM excerpts for quality evaluation from this long call transcript.
Pull exact quotes (not paraphrases) for:
1. OPENING — first ~60 seconds as spoken
2. PITCH MOMENTS — exact recruiter statements about company/offer/pay
3. OBJECTION HANDLING — exact exchanges when driver pushes back
4. TONE/ENERGY — any moments of frustration, rudeness, warmth, or energy shifts
5. PROFANITY/VIOLATIONS — copy exact words if any used
6. CLOSING — last ~60 seconds as spoken
7. RED FLAGS — interrupting, defensiveness, complaints, no next step
Total: 400-600 words max. Use exact quotes, not summaries.`
    : `Extract verbatim quality-evaluation excerpts:
1. OPENING (~45 sec)
2. KEY RECRUITER STATEMENTS
3. OBJECTION HANDLING
4. PROFANITY/VIOLATIONS (exact words)
5. CLOSING/NEXT STEP (~45 sec)
Total: 300-500 words. Exact quotes only.`;

  try {
    const resp = await openai.chat.completions.create({
      model: config.openai.analysisModel,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Transcript (${words} words):\n---\n${transcription}\n---` }
      ],
      max_completion_tokens: 1200
    });
    const compressed = resp.choices[0]?.message?.content || transcription.slice(0, 8000);
    logger.info(`Compressed: ${words} → ${compressed.trim().split(/\s+/).length} words`);
    return { text: compressed, compressed: true, words };
  } catch (err) {
    logger.warn(`Compression failed (${err.message}) — using first 8000 chars`);
    return { text: transcription.slice(0, 8000), compressed: true, words };
  }
}

// ─── Call analysis ──────────────────────────────────────────────────────────

async function analyzeCall(transcription, callMeta = {}) {
  logger.info(`Analyzing call (${callMeta.durationSeconds || 0}s)...`);

  const { text: prepared, compressed, words } = await compressTranscript(transcription);

  const SYSTEM = `You are a professional call quality analyst for American Freight Way / DRENIX trucking carrier.
Evaluate recruiter calls against the company official HR training standards.

${CALL_CRITERIA}

${FOLLOWUP_CRITERIA}

YOUR TASK:
STEP 1 — DETECT CALL TYPE:
  first_contact      = Cold call, recruiter introduces company for first time
  warm_outreach      = Re-engaging cold/ghosted lead with new specific value
  objection_followup = Returning to address a specific objection from last call
  document_collection = Collecting CDL, medical card, MVR, clearinghouse consent, etc.
  status_check       = Checking MVR/drug test/insurance/contract/safety approval status
  onboarding         = Driver approved — orientation, ELD, first dispatch, fuel card
  active_checkin     = Driver running — settlement, loads, dispatch, compliance
  retention          = Driver unhappy or at risk of leaving — save call
  nurture            = Brief low-pressure check-in for parked leads not ready yet

STEP 2 — APPLY CORRECT CRITERIA for the detected type.
  Do NOT penalize pipeline calls for not pitching — not their purpose.
  Do NOT penalize check-in calls for not qualifying — driver already signed.
  Do NOT evaluate a warm outreach as if it were a cold first contact.

STEP 3 — Respond ONLY with valid JSON, no markdown:
{
  "call_type": "<type>",
  "call_type_label": "<human readable>",
  "score": <0-100>,
  "profanity_detected": <bool>,
  "profanity_words": [],
  "manners_rating": "<Excellent|Good|Fair|Poor>",
  "communication_rating": "<Excellent|Good|Fair|Poor>",
  "tone_rating": "<Excellent|Good|Fair|Poor>",
  "listening_rating": "<Excellent|Good|Fair|Poor>",
  "energy_rating": "<Excellent|Good|Fair|Poor>",
  "call_purpose_clear": <bool>,
  "next_step_given": <bool>,
  "behavior_summary": "<2-3 sentences vs correct call type criteria>",
  "strengths": "<specific things recruiter did right>",
  "weaknesses": "<specific violations or None identified>",
  "criteria_violations": [],
  "advice": "<actionable advice for this call type>",
  "short_review": "<1-2 sentence overall review>"
}`;

  const compressionNote = compressed
    ? `[Long call ~${Math.round(words / 130)} min — key excerpts extracted for analysis]`
    : '';

  const USER = [
    `Direction: ${callMeta.direction || 'Unknown'} | Duration: ${callMeta.durationSeconds || 0}s | Date: ${callMeta.startTime || 'Unknown'}`,
    compressionNote,
    '',
    'Transcript:',
    '---',
    prepared,
    '---',
    'Detect call type, then evaluate.'
  ].filter(Boolean).join('\n');

  try {
    const response = await openai.chat.completions.create({
      model: config.openai.analysisModel,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user',   content: USER }
      ],
      max_completion_tokens: 1500
    });

    const raw = response.choices[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      logger.error(`JSON parse fail: ${raw.slice(0, 200)}`);
      parsed = fallbackAnalysis(`JSON parse error: ${e.message}`);
    }

    logger.info(`Done. Type: ${parsed.call_type} | Score: ${parsed.score}`);
    return parsed;
  } catch (err) {
    logger.error(`analyzeCall error: ${err.message}`);
    return fallbackAnalysis(err.message);
  }
}

function fallbackAnalysis(reason) {
  return {
    call_type: 'first_contact',
    call_type_label: 'Unknown — Manual Review Required',
    score: 0,
    profanity_detected: false,
    profanity_words: [],
    manners_rating: 'Fair',
    communication_rating: 'Fair',
    tone_rating: 'Fair',
    listening_rating: 'Fair',
    energy_rating: 'Fair',
    call_purpose_clear: false,
    next_step_given: false,
    behavior_summary: `Analysis error: ${reason}. Manual review required.`,
    strengths: 'Unable to determine',
    weaknesses: 'Unable to determine — manual review required',
    criteria_violations: [],
    advice: 'Please review this call manually.',
    short_review: 'Automated analysis failed — manual review needed.'
  };
}

// ─── Daily summary ──────────────────────────────────────────────────────────

async function generateDailySummary(callReviews, shiftDate) {
  logger.info(`Daily summary: ${shiftDate}, ${callReviews.length} calls`);

  if (!callReviews.length) {
    return { summary: 'No calls were analyzed during this shift.', overallScore: null, totalCalls: 0 };
  }

  const scores = callReviews.map(r => r.analysis?.score).filter(s => typeof s === 'number');
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  const typeCounts = callReviews.reduce((acc, r) => {
    const t = r.analysis?.call_type_label || r.analysis?.call_type || 'Unknown';
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  const reviewsText = callReviews.map((r, i) => {
    const a = r.analysis || {};
    return `Call ${i + 1} [${a.call_type_label || '?'}] (${r.direction || '?'}, ${r.durationSeconds || r.duration_seconds || 0}s):
  Score: ${a.score ?? 'N/A'} | Tone: ${a.tone_rating || '?'} | Energy: ${a.energy_rating || '?'} | Listening: ${a.listening_rating || '?'}
  Profanity: ${a.profanity_detected ? 'YES – ' + (a.profanity_words || []).join(', ') : 'No'}
  Purpose: ${a.call_purpose_clear ? 'Yes' : 'No'} | Next Step: ${a.next_step_given ? 'Yes' : 'No'}
  Review: ${a.short_review || 'N/A'}
  Violations: ${(a.criteria_violations || []).join('; ') || 'None'}
  Advice: ${a.advice || 'N/A'}`;
  }).join('\n\n');

  const resp = await openai.chat.completions.create({
    model: config.openai.analysisModel,
    messages: [
      {
        role: 'system',
        content: 'You are a professional call center performance coach for American Freight Way / DRENIX. Write a specific, constructive, encouraging end-of-shift summary in English.'
      },
      {
        role: 'user',
        content: `Shift: ${shiftDate} | Calls: ${callReviews.length} | Types: ${Object.entries(typeCounts).map(([t, n]) => `${t}(${n})`).join(', ')} | Avg: ${avg ?? 'N/A'}/100\n\n${reviewsText}\n\nWrite shift summary:\n1. Overall performance (note the mix of call types)\n2. Strengths by call type\n3. Areas to improve with specific examples\n4. Top 3 action items for next shift\n5. Motivational closing\nBe specific about WHICH call types had issues.`
      }
    ],
    max_completion_tokens: 1400
  });

  return {
    summary: resp.choices[0]?.message?.content || 'Summary generation failed.',
    overallScore: avg,
    totalCalls: callReviews.length
  };
}

// ─── Weekly summary ─────────────────────────────────────────────────────────

async function generateWeeklySummary(dailyReviews, weekStart, weekEnd) {
  logger.info(`Weekly summary: ${weekStart} → ${weekEnd}`);

  if (!dailyReviews.length) {
    return { summary: 'No data for this week.', overallScore: null };
  }

  const scores = dailyReviews.filter(r => r.avg_score != null).map(r => r.avg_score);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  const text = dailyReviews.map(r =>
    `${r.review_date} (${r.analyzed_calls} calls, avg: ${r.avg_score ?? 'N/A'}/100):\n${r.review_text}\n---`
  ).join('\n\n');

  const resp = await openai.chat.completions.create({
    model: config.openai.analysisModel,
    messages: [
      {
        role: 'system',
        content: 'You are a professional call center performance coach for American Freight Way / DRENIX. Write a comprehensive weekly report covering all call types. Write in English.'
      },
      {
        role: 'user',
        content: `Week: ${weekStart} → ${weekEnd} | Days: ${dailyReviews.length} | Weekly Avg: ${avg ?? 'N/A'}/100\n\n${text}\n\nWrite weekly report:\n1. Week overview and trend\n2. Performance by call type (first contact, warm outreach, pipeline, check-ins, retention)\n3. Consistent strengths across the week\n4. Recurring issues (patterns across multiple days)\n5. Best day and why\n6. Top 3 focus areas for next week\n7. Weekly rating: Poor / Needs Improvement / Good / Excellent\n8. Motivational closing`
      }
    ],
    max_completion_tokens: 2000
  });

  return {
    summary: resp.choices[0]?.message?.content || 'Weekly summary failed.',
    overallScore: avg,
    totalDays: dailyReviews.length
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { transcribeAudio, analyzeCall, generateDailySummary, generateWeeklySummary, sleep };
