/**
 * Inbound SMS handler.
 * Receives Twilio webhooks, routes messages through the OpenClaw gateway,
 * and sends responses back via SMS.
 */

import twilio from 'twilio';
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getProfile,
  saveProfile,
  isOnboarded,
  getCanvasToken,
  saveCanvasToken,
  getAcademicState,
  saveAcademicState,
  getNudgeLog,
  saveNudgeLog,
  hasCalendar,
} from '../lib/student-store.js';
import { CanvasClient, classifyCanvasError } from '../lib/canvas-client.js';
import { generateSetupToken } from './setup-tokens.js';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const anthropic = new Anthropic();

let soulPrompt = null;
let schoolsData = null;

async function getSoulPrompt() {
  if (!soulPrompt) {
    soulPrompt = await readFile(join(process.cwd(), 'SOUL.md'), 'utf8');
  }
  return soulPrompt;
}

async function getSchools() {
  if (!schoolsData) {
    const raw = await readFile(
      join(process.cwd(), 'config', 'schools.json'),
      'utf8'
    );
    schoolsData = JSON.parse(raw);
  }
  return schoolsData;
}

/**
 * Classify intent to decide which model to use.
 * Returns 'haiku' for simple lookups, 'sonnet' for everything else.
 */
function classifyModelTier(message, isSetupComplete) {
  if (!isSetupComplete) return 'sonnet'; // onboarding needs personality

  const lower = message.toLowerCase().trim();

  // Simple factual lookups → haiku
  const simpleLookups = [
    /^when\s+(is|are)\s/,
    /^what('s| is)\s+due/,
    /^due\s+dates?/,
    /^grades?$/,
    /^what\s+did\s+i\s+get/,
    /^courses?$/,
  ];
  if (simpleLookups.some((r) => r.test(lower))) return 'haiku';

  return 'sonnet';
}

function getModel(tier) {
  return tier === 'haiku'
    ? 'claude-haiku-4-5-20251001'
    : 'claude-sonnet-4-6';
}

/**
 * Handle an inbound SMS from Twilio.
 */
export async function handleInboundSms(req, res) {
  const { From: phone, Body: message } = req.body;

  // Acknowledge immediately so Twilio doesn't retry
  res.type('text/xml').send('<Response></Response>');

  try {
    const response = await processMessage(phone, message);
    if (response) {
      await sendSms(phone, response);
    }
  } catch (err) {
    console.error(`Error processing message from ${phone}:`, err);
    await sendSms(
      phone,
      "Hey, I hit a snag on my end. Try again in a sec?"
    );
  }
}

/**
 * Process a student's message and return the response text.
 */
async function processMessage(phone, message) {
  const profile = await getProfile(phone);
  const soul = await getSoulPrompt();

  // --- Check for quiet/mute requests ---
  if (isQuietRequest(message)) {
    return await handleQuietRequest(phone);
  }

  // --- Mark nudges as responded ---
  const nudgeLog = await getNudgeLog(phone);
  if (nudgeLog.nudges.length > 0) {
    // Mark recent nudges as responded
    const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
    nudgeLog.nudges
      .filter((n) => new Date(n.sent_at).getTime() > recentCutoff && !n.responded)
      .forEach((n) => (n.responded = true));
    nudgeLog.reduced_frequency = false;
    await saveNudgeLog(phone, nudgeLog);
  }

  // --- Onboarding flow ---
  if (!profile || !profile.setup_complete) {
    return await handleOnboarding(phone, message, profile);
  }

  // --- Main conversation ---
  const tier = classifyModelTier(message, true);
  const systemPrompt = await buildSystemPrompt(phone, profile, soul);

  const response = await anthropic.messages.create({
    model: getModel(tier),
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
  });

  return response.content[0].text;
}

/**
 * Build the system prompt with student context.
 */
async function buildSystemPrompt(phone, profile, soul) {
  const state = await getAcademicState(phone);
  const calConnected = profile.calendar_connected;
  const now = new Date();

  let context = `${soul}\n\n## Current Student Context\n`;
  context += `- Name: ${profile.name}\n`;
  context += `- School: ${profile.school}\n`;
  context += `- Timezone: ${profile.timezone}\n`;
  context += `- Calendar connected: ${calConnected ? 'yes' : 'no'}\n`;
  context += `- Current time (their timezone): ${now.toLocaleString('en-US', { timeZone: profile.timezone })}\n\n`;

  if (state.courses.length > 0) {
    context += `## Active Courses\n`;
    for (const c of state.courses) {
      context += `- ${c.name} (${c.code})\n`;
    }
    context += '\n';
  }

  if (state.assignments.length > 0) {
    context += `## Upcoming Assignments\n`;
    const upcoming = state.assignments.filter(
      (a) => new Date(a.due_at) > now
    );
    for (const a of upcoming.slice(0, 20)) {
      const due = new Date(a.due_at);
      const dueStr = due.toLocaleString('en-US', {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: profile.timezone,
      });
      context += `- ${a.course_name} — ${a.name}, due ${dueStr}`;
      if (a.submitted) context += ' (SUBMITTED)';
      if (a.grade != null) context += ` (grade: ${a.grade})`;
      context += '\n';
    }
    context += '\n';
  }

  if (!calConnected) {
    const token = generateSetupToken(phone);
    const baseUrl = process.env.WEB_BASE_URL || 'https://studyclaw.com';
    context += `## Calendar Setup Link\n`;
    context += `If the student wants to connect their calendar, share this link: ${baseUrl}/connect/calendar/${token}\n\n`;
  }

  context += `## Rules for Responding\n`;
  context += `- Keep responses under 300 characters when possible (SMS)\n`;
  context += `- Use the student's name occasionally but not every message\n`;
  context += `- Sort assignments by due date (soonest first)\n`;
  context += `- Use relative dates (tomorrow, this Wednesday, etc.)\n`;
  context += `- If the student asks to do their homework for them, decline warmly and offer to help plan instead\n`;
  context += `- If something seems broken, guide them through reconnecting without technical jargon\n`;

  return context;
}

/**
 * Handle the multi-step onboarding conversation.
 */
async function handleOnboarding(phone, message, existingProfile) {
  const soul = await getSoulPrompt();
  const profile = existingProfile || { phone };

  // Step 1: No profile at all — greeting
  if (!existingProfile) {
    await saveProfile(phone, { phone, onboarding_step: 'name' });
    return `Hey! 👋 I'm StudyClaw — think of me as a study buddy who always knows what's due. I'll text you reminders, help you plan your week, and make sure nothing sneaks up on you.\n\nWhat's your first name?`;
  }

  const step = profile.onboarding_step || 'name';

  if (step === 'name') {
    const name = message.trim().split(/\s+/)[0];
    // Capitalize first letter
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    profile.name = capitalized;
    profile.onboarding_step = 'school';
    await saveProfile(phone, profile);
    return `Hey ${capitalized}! First I need to connect to your school so I can see your assignments. What school are you at?`;
  }

  if (step === 'school') {
    const schools = await getSchools();
    const input = message.trim();

    // Try to match the school
    let matched = null;
    for (const [name, data] of Object.entries(schools)) {
      if (input.toLowerCase().includes(name.toLowerCase()) ||
          name.toLowerCase().includes(input.toLowerCase())) {
        matched = { name, ...data };
        break;
      }
    }

    if (matched) {
      profile.school = matched.name;
      profile.canvas_url = matched.canvas_url;
      profile.timezone = matched.timezone;
      profile.onboarding_step = 'token';
      await saveProfile(phone, profile);

      return `Got it! I need a quick access key from ${matched.nickname} so I can see your courses and due dates. Here's how to grab it — takes about 30 seconds:\n\n1. Open ${matched.canvas_url} and log in\n2. Tap your profile icon → Settings\n3. Scroll down to "Approved Integrations"\n4. Tap "+ New Access Token"\n5. Name it anything (like "StudyClaw"), tap Generate\n6. Copy the token and paste it back here\n\n(I'll only use this to read your assignments — I can't change anything in your account.)`;
    }

    // School not found
    profile.onboarding_step = 'school_url';
    await saveProfile(phone, profile);
    return `I'm not sure which Canvas site your school uses. What's the website where you check your assignments? It usually looks like canvas.something.edu or something.instructure.com.`;
  }

  if (step === 'school_url') {
    const input = message.trim();
    // Try to extract a URL
    const urlMatch = input.match(/(https?:\/\/[^\s]+|[\w.-]+\.(edu|com)[^\s]*)/i);
    if (urlMatch) {
      let url = urlMatch[0];
      if (!url.startsWith('http')) url = `https://${url}`;
      profile.school = input;
      profile.canvas_url = url;
      profile.timezone = 'America/New_York'; // default, will confirm
      profile.onboarding_step = 'token';
      await saveProfile(phone, profile);

      return `Got it! I need a quick access key from Canvas so I can see your courses. Here's how:\n\n1. Open ${url} and log in\n2. Tap your profile icon → Settings\n3. Scroll down to "Approved Integrations"\n4. Tap "+ New Access Token"\n5. Name it anything (like "StudyClaw"), tap Generate\n6. Copy the token and paste it back here`;
    }

    return `Hmm, I couldn't find a Canvas URL in that. Can you paste the web address you use to check your assignments? It usually looks like canvas.something.edu`;
  }

  if (step === 'token') {
    const token = message.trim();

    // Canvas tokens typically start with digits followed by ~ then alphanumeric
    if (token.length < 20) {
      return `That looks too short to be an access token. Make sure you copied the full token — it's usually a long string of letters and numbers starting with a number and a ~.`;
    }

    // Validate the token
    try {
      const client = new CanvasClient(profile.canvas_url, token);
      await client.validateToken();
      const { courses, assignments } = await client.fullSync();

      // Save everything
      await saveCanvasToken(phone, token);
      await saveAcademicState(phone, {
        courses,
        assignments,
        last_sync: new Date().toISOString(),
      });

      profile.onboarding_step = 'confirm_courses';
      await saveProfile(phone, profile);

      const courseList = courses.map((c) => `- ${c.name}`).join('\n');
      return `Connected! I can see ${courses.length} course${courses.length === 1 ? '' : 's'}:\n${courseList}\n\nDoes that look right?`;
    } catch (err) {
      if (!profile.token_attempts) profile.token_attempts = 0;
      profile.token_attempts++;
      await saveProfile(phone, profile);

      if (profile.token_attempts >= 2) {
        return `Still not connecting. Double-check that you're on ${profile.canvas_url} and that the token was just created. Sometimes it helps to generate a fresh one.`;
      }
      return `Hmm, that didn't work. Make sure you copied the full token — it's usually a long string of letters and numbers. Want to try again?`;
    }
  }

  if (step === 'confirm_courses') {
    const lower = message.toLowerCase().trim();
    if (
      lower.includes('yes') || lower.includes('yep') || lower.includes('yeah') ||
      lower.includes('yup') || lower.includes('looks right') || lower.includes('correct')
    ) {
      profile.onboarding_step = 'calendar';
      await saveProfile(phone, profile);

      const setupToken = generateSetupToken(phone);
      const baseUrl = process.env.WEB_BASE_URL || 'https://studyclaw.com';
      return `Nice! One more thing — if you want me to check your schedule and add study time to your calendar, tap this link to connect Google Calendar:\n\n${baseUrl}/connect/calendar/${setupToken}\n\n(Totally optional — I can still track deadlines without it.)`;
    }

    // Courses don't look right
    profile.onboarding_step = 'token';
    profile.token_attempts = 0;
    await saveProfile(phone, profile);
    return `No worries — let's try reconnecting. Can you generate a new access token and paste it here?`;
  }

  if (step === 'calendar') {
    // Whether they connected calendar or just texted back, move on
    profile.setup_complete = true;
    profile.preferences = {
      wake_time: '08:00',
      sleep_time: '23:00',
      morning_brief: true,
      deadline_nudges: true,
      grade_notifications: true,
      weekly_preview: true,
    };
    profile.onboarding_step = 'complete';
    await saveProfile(phone, profile);

    const calConnected = await hasCalendar(phone);
    const calMsg = calConnected ? 'Calendar connected! ' : '';

    return `${calMsg}You're all set 🎉\n\nStarting tomorrow, I'll text you each morning with what's on your plate. You can text me anytime — here are some things people ask me:\n\n"What's due this week?"\n"Help me plan my study time"\n"When should I start my essay?"\n\nTalk soon!`;
  }

  // Fallback: restart onboarding
  profile.onboarding_step = 'name';
  await saveProfile(phone, profile);
  return `Hey! I don't think we've finished setting up. What's your first name?`;
}

function isQuietRequest(message) {
  const lower = message.toLowerCase().trim();
  const quietWords = ['stop', 'quiet', 'mute', 'shut up', 'shh', 'leave me alone', 'too many texts'];
  return quietWords.some((w) => lower.includes(w));
}

async function handleQuietRequest(phone) {
  const nudgeLog = await getNudgeLog(phone);
  const previousQuiets = nudgeLog.nudges.filter(
    (n) => n.type === 'quiet_request'
  ).length;

  const quietDuration = previousQuiets >= 1 ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  nudgeLog.quiet_until = new Date(Date.now() + quietDuration).toISOString();
  nudgeLog.nudges.push({
    sent_at: new Date().toISOString(),
    type: 'quiet_request',
    responded: true,
  });
  await saveNudgeLog(phone, nudgeLog);

  if (previousQuiets >= 1) {
    return "Got it — I'll be quiet for the week. Text me anytime you need me.";
  }
  return "Got it — I'll be quiet. Text me anytime you need me, and I'll start the morning check-ins again tomorrow.";
}

/**
 * Send an SMS to a student.
 */
export async function sendSms(phone, body) {
  // Split long messages into chunks (SMS limit is ~1600 chars for Twilio,
  // but we aim for shorter messages per the SOUL.md guidelines)
  const chunks = splitMessage(body, 1500);

  for (const chunk of chunks) {
    await twilioClient.messages.create({
      to: phone,
      from: process.env.TWILIO_PHONE_NUMBER,
      body: chunk,
    });
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at a paragraph break
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      // Try a single newline
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // Try a sentence end
      splitIdx = remaining.lastIndexOf('. ', maxLen);
      if (splitIdx > 0) splitIdx += 1;
    }
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
