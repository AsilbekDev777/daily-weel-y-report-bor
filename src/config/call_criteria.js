'use strict';

/**
 * Call Quality Criteria — American Freight Way / DRENIX
 * Source: HR_2025.pdf (187-page training manual) — full extraction
 */

const CALL_CRITERIA = `
====================================================================
AMERICAN FREIGHT WAY / DRENIX — RECRUITER CALL STANDARDS
====================================================================
CONTEXT: Trucking recruiter calls to owner-operators (CDL-A drivers).
Carrier: American Freight Way / Bipolar Bear Enterprises, Hattiesburg MS.
MC #1257747 | USDOT #3650011. Evaluate the RECRUITER only.

━━━ ABSOLUTE PROHIBITIONS (ZERO TOLERANCE) ━━━

❌ LANGUAGE: Profanity, offensive/crude/sexual/discriminatory language
❌ CONDUCT: Rude or dismissive to driver or their family — EVER
❌ CONDUCT: Arguing, raising voice, matching hostile energy
❌ CONDUCT: Getting defensive or taking rejection personally
❌ CONDUCT: Badmouthing competitor carriers by name
❌ CONDUCT: Making promises that cannot be kept
❌ CONDUCT: Talking over the driver or interrupting repeatedly
❌ PERFORMANCE: Sounding tired, bored, cold, or disinterested
❌ PERFORMANCE: Calling without a clear purpose
❌ PERFORMANCE: Leaving a call without confirming a next step

━━━ REQUIRED CONDUCT ━━━

✅ Polite, respectful, professional on EVERY call — even if driver says no
✅ Treat drivers as BUSINESS OWNERS, not applicants
✅ Emotionally bulletproof — rejection is normal, not personal
✅ Greet by last name (Mr. [Last Name]) — shows respect
✅ CONVERSATION ENERGY MATH (mandatory):
   Recruiter DOWN + Driver DOWN = NO conversion
   Recruiter DOWN + Driver UP = NO trust
   Recruiter UP + Driver DOWN = NO confidence
   Recruiter UP + Driver UP = CONVERSION ✅
   → Recruiter MUST bring positive energy regardless of driver's mood

━━━ LISTENING REQUIREMENTS ━━━
✅ Listen MORE than you talk — active listening is a core skill
✅ Respond to what driver actually says, not just the next pitch point
✅ Driver's pain tells you how to pitch — listen for it
✅ When they open up emotionally, you win — emotion = leverage
✅ Use silence after asking about current rates or frustrations

━━━ HOSTILE DRIVER PROTOCOL ━━━
If driver curses, yells, or says "Stop calling me!":
→ "No problem at all, I'll take you off our list. Have a great day." [hang up]
→ NEVER argue or match energy. Never delete driver who owns a truck.

━━━ OBJECTION STANDARDS ━━━
"Not interested"         → Acknowledge calmly, ask why, leave warm door open
"Happy with carrier"     → Respect it: "If your dispatcher drops the ball, call me first"
"Talk to my wife"        → Validate: "Smart. Have her call me with questions."
"Been scammed before"    → Offer FMCSA SAFER verification (MC #1257747)
"Fee too high"           → Pivot to NET earnings: "Our drivers gross $2K more/week"
"Want to keep my MC"     → Educate on lease vs own MC — respectfully

━━━ VOCAL STANDARDS ━━━
✅ Confident, resonant, varied pitch — NOT monotone
✅ Clear articulation, appropriate pace, audible smile
✅ "Your tone sells more than your script"
❌ Uptalking (statements as questions?), monotone, weak/breathy voice
❌ Filler words: "um," "uh," "ah," "so," "kind of," "you know"
❌ Rushing (sounds scripted), mumbling

━━━ LANGUAGE STYLE ━━━
✅ Speak like a dispatcher or trucking buddy, NOT a corporate call center rep
✅ Acceptable rapport: "Brother," "Bossman," "Partner," "Driver"
✅ OUTCOME language — never just features:
   ❌ "We have 24/7 dispatch" → ✅ "You'll never wait on a dispatcher at midnight again"
   ❌ "Pre-booked loads" → ✅ "You stay loaded and rolling — no chasing freight on load boards"
   ❌ "Weekly pay" → ✅ "You know exactly what hits your account every Friday"

━━━ FIRST CONTACT CALL STRUCTURE (2–4 minutes) ━━━
1. OPENER — name, company, get to the point fast with authority
2. QUALIFYING: own truck or lease? solo/team? own trailer or power-only?
   current gross? biggest frustration? ready to move when? clear MVR/Clearinghouse?
3. PITCH — 30 seconds, outcome-focused, based on what driver said
4. OBJECTION HANDLING — smooth, never defensive
5. CLOSE — always ask for next step, never leave call open-ended

━━━ INDUSTRY KNOWLEDGE (must demonstrate) ━━━
Gross vs Net, RPM, fuel/IFTA/tolls, deadhead, Amazon vs brokered freight,
Dry Van vs Power Only, ELD compliance, insurance types (Liability/Cargo/NTL/
Bobtail/Physical Damage), escrow, DOT inspection seasons.
"If driver asks about freight type and recruiter says I'm not sure — deal is at risk"

━━━ TRANSPARENCY ━━━
✅ Show every deduction upfront — never hide fees
✅ Offer FMCSA SAFER verification
✅ "Recruit drivers like investors — because they ARE investing their truck"

━━━ FOLLOW-UP DISCIPLINE ━━━
✅ 80% of sales happen after the 5th contact — follow up relentlessly but respectfully
✅ Drop new lane updates or better loads to re-engage cold leads
✅ Reconnect after holidays, fuel price changes, DOT blitz weeks
✅ Always have a reason when you call back
`;

const FOLLOWUP_CRITERIA = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CALL TYPE DETECTION & CRITERIA — READ BEFORE EVALUATING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Identify the call type FIRST, then apply correct criteria.
Score ONLY against the criteria for the detected call type.

─────────────────────────────────────────────
TYPE 1: first_contact — Cold Call
─────────────────────────────────────────────
Signs: Recruiter introduces company for first time. Driver doesn't know recruiter.
Recruiter asks basic qualification questions (own truck? what are you grossing?).
Apply: Full FIRST CONTACT CALL STRUCTURE above. Score on qualifying, pitch, close.

─────────────────────────────────────────────
TYPE 2: warm_outreach — Re-engaging with New Value
─────────────────────────────────────────────
Signs: Had contact before. Driver went cold or ghosted. Recruiter returns with
NEW specific value: new lane, rate increase, driver success story, market change.
Phrases: "I've got something new," "rates went up on your lane," "just had a driver
start that run $500 more/week," "after the DOT blitz season," "wanted to reach back."
✅ REQUIRED: Specific new value (not just "checking in"), brief 1-2 min, warm not desperate,
   one qualifying question, clear but low-pressure next step.
❌ NEVER: Sound desperate, guilt-trip ("I've been trying to reach you"), re-pitch everything.

─────────────────────────────────────────────
TYPE 3: objection_followup — Returning to Address Specific Objection
─────────────────────────────────────────────
Signs: Driver had specific objection last call (needs to talk to wife, needs to
think, comparing carriers, bad experience before). Recruiter calls back with answer.
Phrases: "last time you mentioned," "you said you wanted to talk to your wife,"
"I looked into what you asked about," "I have an answer to your question about..."
✅ REQUIRED: Reference the SPECIFIC objection, bring direct answer/resolution,
   stay focused (don't re-pitch everything), confirm if situation has changed, next step.
❌ NEVER: Forget what was said, pressure without addressing the real objection.

─────────────────────────────────────────────
TYPE 4: document_collection — Gathering Paperwork
─────────────────────────────────────────────
Signs: Collecting CDL, medical card, annual inspection, clearinghouse consent,
MVR authorization, W9, voided check, 2290, IRP plates, ELD info, proof of insurance.
✅ REQUIRED: State purpose immediately. Specific about exactly what is needed.
   Explain WHY each doc is needed. Set clear deadline ("text a photo today by 3 PM CT").
   Offer to help if stuck. Confirm what was received vs what is still missing.
   Give timeline: "Once we have everything, Safety reviews in 24-48 hours."
❌ NEVER: Vague about what's needed, pressure without explanation, ask for same doc twice.

─────────────────────────────────────────────
TYPE 5: status_check — Following Up on Pending Items
─────────────────────────────────────────────
Signs: Checking status of MVR, drug test, clearinghouse, insurance quote,
safety pre-approval, background check, contract sent/awaiting signature.
✅ REQUIRED: State exactly what you're checking and why. Have the status ready
   before calling if possible. Give specific timeline if still pending.
   Be transparent if there's a problem. Keep it brief (60-90 sec if no issues).
❌ NEVER: Call to say "I don't know yet," be vague about timelines, hide problems.

─────────────────────────────────────────────
TYPE 6: onboarding — Setting Up Approved Driver
─────────────────────────────────────────────
Signs: Driver is approved and setting up for first load. Topics: orientation
scheduling, ELD device setup, fuel card, first dispatch, 2290, IRP plates,
settlement/direct deposit setup, truck inspection reminder.
✅ REQUIRED: Organized and know where driver is in checklist. Walk through each
   step clearly and patiently. Explain each step and what happens after.
   Express genuine excitement ("You're almost ready to roll!"). Verify driver
   has everything (ELD, fuel card, first load details, settlement info).
❌ NEVER: Rush driver through setup, assume they know what to do, skip steps.

─────────────────────────────────────────────
TYPE 7: active_checkin — Driver is Running
─────────────────────────────────────────────
Signs: Driver is actively hauling loads. Topics: how first week went, settlement
accuracy, load availability/volume, dispatch responsiveness, equipment issues,
compliance reminders (annual inspection due, DOT blitz prep, ELD renewal, 2290).
✅ REQUIRED: Specific questions, not generic ("Did your Friday settlement look
   right?" not "How's everything?"). Acknowledge driver's effort. Listen to
   complaints seriously and escalate if needed. Have answers ready. Solution-oriented.
   Compliance reminders should be helpful, not threatening.
❌ NEVER: Generic check-in with no substance, dismiss complaints, call without reason.

─────────────────────────────────────────────
TYPE 8: retention — Driver Unhappy or At Risk of Leaving
─────────────────────────────────────────────
Signs: Driver has complained, mentioned leaving, comparing other carriers,
or went quiet. This is a SAVE call — treat it as highest priority.
✅ REQUIRED: Acknowledge the problem FIRST before defending anything.
   Validate driver's feelings. Concrete solution with specific timeline.
   Only commit to what you can actually control. End with clear action plan:
   "Here's exactly what I'm doing and by when."
❌ NEVER: Defensive, dismiss complaint as overreaction, make empty promises,
   re-pitch the carrier like it's a new call, get emotional.

─────────────────────────────────────────────
TYPE 9: nurture — Low-Pressure Check-in for Parked Leads
─────────────────────────────────────────────
Signs: Driver previously said "not yet," "maybe next month," "waiting on my
trailer." Recruiter staying on radar without pressure. 60-90 seconds max.
✅ REQUIRED: Brief. Reference when last spoke and what changed since.
   Bring ONE relevant update (rate change, new lane, driver success story).
   Zero pressure: "Just wanted to stay on your radar. When you're ready, I'm here."
   Offer to follow up in 30 days if still not ready.
❌ NEVER: Long call, pressure, re-pitch entire offer, sound impatient with timeline.

─────────────────────────────────────────────
UNIVERSAL RULES (ALL call types)
─────────────────────────────────────────────
✅ Always: Professional tone, no profanity, positive energy, listen actively, thank driver
✅ Always: Clear next step at end of every call — no exceptions

AUTOMATIC SCORE PENALTIES (all types):
❌ Profanity/offensive language   → score cannot exceed 50
❌ Rude to driver or family       → score cannot exceed 60
❌ Argumentative / defensive      → -20 points
❌ Matched hostile energy         → -20 points
❌ Monotone/dead energy throughout → -15 points
❌ No clear purpose for call      → -15 points
❌ No next step at end            → -10 points

SCORING RANGES (apply to all types):
90-100: Excellent — appropriate for call type, listened, purposeful, clear next step
75-89:  Good — mostly professional, minor issues
60-74:  Fair — wrong approach for call type, unclear purpose, or weak close
40-59:  Poor — wrong call type approach, weak energy, no close, or conduct issues
0-39:   Unacceptable — profanity, rudeness, aggression, or serious misconduct
`;

module.exports = { CALL_CRITERIA, FOLLOWUP_CRITERIA };
