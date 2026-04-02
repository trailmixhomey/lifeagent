/**
 * Message handler.
 * Processes student messages and generates responses via the OpenClaw gateway.
 */

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
  getConversation,
  saveConversation,
  getCuratedMemory,
  getRecentMemory,
  appendMemory,
  getCommitments,
  updateCommitments,
  getGCalTokens,
  getEffortHistory,
  getCustomDeadlines,
  saveCustomDeadlines,
} from '../lib/student-store.js';
import { searchMemory } from '../lib/memory-search.js';
import { CanvasClient, classifyCanvasError } from '../lib/canvas-client.js';
import { getEvents, createStudyEvent, updateCalendarEvent, deleteCalendarEvent, classifyCalendarError } from '../lib/calendar-client.js';
import { estimateEffort, formatHours, prioritizeAssignments } from '../lib/effort-estimator.js';
import { findSlots, rankSlots, buildStudyPlan } from '../lib/availability-finder.js';
import { classifyIntent, getModelTier } from '../lib/intent-classifier.js';
import { generateSetupToken } from './setup-tokens.js';

// Re-export sendMessage so cron-runner and other modules can import from here
export { sendMessage } from './whatsapp-listener.js';

const anthropic = new Anthropic();

const MAX_CONVERSATION_MESSAGES = 20; // 10 turns (user+assistant pairs)

const PLANNING_TOOLS = [
  {
    name: 'get_calendar_events',
    description: 'Get events from the student\'s Google Calendar for a date range. Use this to see what they have going on before suggesting study times.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
        end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'find_study_slots',
    description: 'Find available time slots for studying based on the student\'s calendar, wake/sleep hours, and meal times. Returns ranked slots avoiding conflicts.',
    input_schema: {
      type: 'object',
      properties: {
        duration_hours: { type: 'number', description: 'How long the study session needs to be in hours' },
        start_date: { type: 'string', description: 'Start of search range (YYYY-MM-DD)' },
        end_date: { type: 'string', description: 'End of search range (YYYY-MM-DD)' },
        urgent: { type: 'boolean', description: 'If true, allow late-night slots. Use when deadline is <24 hours away.' },
      },
      required: ['duration_hours', 'start_date', 'end_date'],
    },
  },
  {
    name: 'estimate_effort',
    description: 'Estimate how long an assignment will take based on its type and the student\'s history with similar work.',
    input_schema: {
      type: 'object',
      properties: {
        assignment_type: { type: 'string', description: 'Type: essay, problem_set, quiz, lab, discussion, reading, presentation, project, exam, assignment' },
        course_id: { type: 'number', description: 'Course ID from the academic state' },
      },
      required: ['assignment_type'],
    },
  },
  {
    name: 'build_study_plan',
    description: 'Build a complete study plan for assignments due within the next 7 days. Prioritizes by deadline proximity, difficulty, and point value. Schedules sessions a few days before deadlines. Never suggests starting more than a week early.',
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: { type: 'number', description: 'How many days ahead to plan (default 7)' },
      },
    },
  },
  {
    name: 'get_planner',
    description: 'Get the student\'s unified to-do list from Canvas — includes assignments, quizzes, discussions, and graded items across all courses. Better than just looking at the system prompt for a complete picture.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date (YYYY-MM-DD), defaults to today' },
        end_date: { type: 'string', description: 'End date (YYYY-MM-DD), defaults to 14 days from now' },
      },
    },
  },
  {
    name: 'get_grades',
    description: 'Get the student\'s current grades across all courses. Shows current score, current grade letter, and final score if available.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_course_detail',
    description: 'Get detailed info about a specific course. Use for syllabus content, module structure, calendar events, announcements, discussions, quizzes, rubrics, files, or conferences. Pick only what you need.',
    input_schema: {
      type: 'object',
      properties: {
        course_id: { type: 'number', description: 'Course ID' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['announcements', 'discussions', 'quizzes', 'rubrics', 'files', 'conferences', 'syllabus', 'modules', 'events'] },
          description: 'What to fetch. Pick only what\'s needed.',
        },
      },
      required: ['course_id'],
    },
  },
  {
    name: 'get_feedback',
    description: 'Get professor feedback (submission comments and rubric scores) on a specific assignment.',
    input_schema: {
      type: 'object',
      properties: {
        course_id: { type: 'number', description: 'Course ID' },
        assignment_id: { type: 'number', description: 'Assignment ID' },
      },
      required: ['course_id', 'assignment_id'],
    },
  },
  {
    name: 'get_groups',
    description: 'Get the student\'s group memberships and group members for group projects.',
    input_schema: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: 'Optional: specific group ID to get members for' },
      },
    },
  },
  {
    name: 'manage_deadlines',
    description: 'Add, list, edit, or remove custom deadlines that the student tells you about (exams, project due dates, etc. not in Canvas). Use this whenever a student mentions a deadline or date for something. Also use when they ask "what do I have coming up" to get the full picture. Use edit when a student corrects a date or detail on an existing deadline.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'edit', 'remove'], description: 'What to do' },
        name: { type: 'string', description: 'Name of the deadline (for add/edit/remove). For edit, matches existing deadline by name.' },
        course: { type: 'string', description: 'Course name (for add, or to update on edit)' },
        date: { type: 'string', description: 'Due date as a readable string like "April 15" or "2026-04-15" (for add, or to update on edit)' },
        type: { type: 'string', description: 'Type: exam, project, paper, presentation, other (for add, or to update on edit)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'search_course_files',
    description: 'Search a course\'s files for documents like syllabi, study guides, or lecture notes. Can also download and read PDF content to find exam dates, schedules, etc.',
    input_schema: {
      type: 'object',
      properties: {
        course_id: { type: 'number', description: 'Course ID' },
        search_term: { type: 'string', description: 'Search term (e.g., "syllabus", "exam", "schedule")' },
        read_file_id: { type: 'number', description: 'If set, download and read this file\'s content (for PDFs)' },
      },
      required: ['course_id'],
    },
  },
  {
    name: 'create_calendar_event',
    description: 'Create a study time event on the student\'s Google Calendar. Only call this after the student has confirmed they want it added. The event_title appears as the calendar event name — always include the course name or a relevant subject descriptor so the student knows what the block is for at a glance.',
    input_schema: {
      type: 'object',
      properties: {
        event_title: {
          type: 'string',
          description: 'Title for the calendar event. Use the course name + assignment name (e.g. "MATH 201: Problem Set 5"). If the exact course name is unknown, infer a subject descriptor from context (e.g. "Biology: Lab Report", "History: Essay Draft"). Ask the student what course/subject this is for before calling this tool if you truly cannot determine it.',
        },
        due_date: { type: 'string', description: 'When the assignment is due (human readable)' },
        start_time: { type: 'string', description: 'Start time in ISO 8601 format' },
        end_time: { type: 'string', description: 'End time in ISO 8601 format' },
      },
      required: ['event_title', 'start_time', 'end_time'],
    },
  },
  {
    name: 'edit_calendar_event',
    description: 'Edit an existing event on the student\'s Google Calendar. Use get_calendar_events first to find the event ID. Only provided fields will be updated — omit fields the student doesn\'t want to change.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The event ID from get_calendar_events' },
        event_title: { type: 'string', description: 'New title for the event (omit to keep current title)' },
        start_time: { type: 'string', description: 'New start time in ISO 8601 format (omit to keep current)' },
        end_time: { type: 'string', description: 'New end time in ISO 8601 format (omit to keep current)' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: 'Delete an event from the student\'s Google Calendar. Use get_calendar_events first to find the event ID. Confirm with the student before deleting.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The event ID from get_calendar_events' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'update_preferences',
    description: 'Update the student\'s preferences. Use when they want to change their wake/sleep time, turn nudges on/off, change their buddy name, or switch their vibe. Only include fields the student wants to change.',
    input_schema: {
      type: 'object',
      properties: {
        wake_time: { type: 'string', description: 'Wake time in HH:MM format (e.g. "09:00")' },
        sleep_time: { type: 'string', description: 'Sleep time in HH:MM format (e.g. "23:00")' },
        morning_brief: { type: 'boolean', description: 'Whether to send morning briefs' },
        deadline_nudges: { type: 'boolean', description: 'Whether to send deadline reminder nudges' },
        grade_notifications: { type: 'boolean', description: 'Whether to notify about new/changed grades' },
        weekly_preview: { type: 'boolean', description: 'Whether to send the Sunday weekly preview' },
        buddy_name: { type: 'string', description: 'What the student wants to call their buddy' },
        vibe: { type: 'string', enum: ['chill', 'hype', 'straight-shooter', 'gentle'], description: 'Communication vibe/personality' },
      },
    },
  },
];

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

function getModel(tier) {
  return tier === 'haiku'
    ? 'claude-haiku-4-5-20251001'
    : 'claude-sonnet-4-6';
}


/**
 * Process a student's message and return the response text.
 */
export async function processMessage(phone, message, mediaData = null) {
  const profile = await getProfile(phone);
  const soul = await getSoulPrompt();
  const intent = (mediaData && !message) ? 'general' : classifyIntent(message);

  // --- Check for quiet/mute requests ---
  if (intent === 'quiet') {
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
    // During token step, try extracting a Canvas token from a screenshot
    if (mediaData && profile?.onboarding_step === 'token') {
      const extractedToken = await extractTokenFromImage(mediaData);
      if (extractedToken) {
        const onboardingResponse = await handleOnboarding(phone, extractedToken, profile);
        return splitResponse(onboardingResponse);
      }
    }
    const onboardingResponse = await handleOnboarding(phone, message || 'hi', profile);
    return splitResponse(onboardingResponse);
  }

  // --- Main conversation ---
  const tier = mediaData ? 'sonnet' : getModelTier(intent, true);
  const systemPrompt = await buildSystemPrompt(phone, profile, soul, message);

  // Always include planning tools — Claude decides when to use them
  const tools = PLANNING_TOOLS;

  // Load conversation history
  const convo = await getConversation(phone);
  const historyMessages = convo.messages.slice(-MAX_CONVERSATION_MESSAGES);

  // Build user content — multi-part when media is present
  let userContent;
  if (mediaData) {
    const contentParts = [];
    if (mediaData.mimeType === 'application/pdf') {
      contentParts.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: mediaData.base64 },
      });
    } else if (isWordDoc(mediaData.mimeType)) {
      const docText = await extractWordText(mediaData.base64);
      if (docText.trim()) {
        contentParts.push({ type: 'text', text: `[Document content]\n${docText}` });
      } else {
        contentParts.push({ type: 'text', text: '[The student sent a Word document but the text could not be extracted. Let them know and ask them to try sending it as a PDF or screenshot instead.]' });
      }
    } else if (isSpreadsheet(mediaData.mimeType)) {
      const sheetText = await extractExcelText(mediaData.base64);
      if (sheetText.trim()) {
        contentParts.push({ type: 'text', text: `[Spreadsheet content]\n${sheetText}` });
      } else {
        contentParts.push({ type: 'text', text: '[The student sent a spreadsheet but the content could not be extracted. Ask them to try sending it as a PDF or screenshot instead.]' });
      }
    } else if (mediaData.mimeType?.startsWith('image/')) {
      contentParts.push({
        type: 'image',
        source: { type: 'base64', media_type: normalizeMediaType(mediaData.mimeType), data: mediaData.base64 },
      });
    } else {
      // Unknown file type — log it and skip the media
      console.log(`[Media] Unsupported mime type: ${mediaData.mimeType}, skipping media`);
      contentParts.push({ type: 'text', text: `[The student sent a file (${mediaData.mimeType}) that I can't read. Let them know you can handle photos, PDFs, Word docs, and Excel files.]` });
    }
    const defaultMsg = mediaData.mimeType?.startsWith('image/')
      ? 'The student sent this image.'
      : 'The student sent a document. Extract any dates, deadlines, grading info, and other key details from it.';
    contentParts.push({ type: 'text', text: message || defaultMsg });
    userContent = contentParts;
  } else {
    userContent = message;
  }
  historyMessages.push({ role: 'user', content: userContent });

  // Call Claude with optional tool access
  let response = await anthropic.messages.create({
    model: getModel(tier),
    max_tokens: 1024,
    system: systemPrompt,
    messages: historyMessages,
    tools,
  });

  // Tool use loop — execute tools and send results back until Claude gives a text response
  while (response.stop_reason === 'tool_use') {
    const toolBlocks = response.content.filter((b) => b.type === 'tool_use');
    const assistantContent = response.content;

    historyMessages.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];
    for (const toolCall of toolBlocks) {
      const result = await executeTool(toolCall.name, toolCall.input, phone, profile);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    historyMessages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: getModel(tier),
      max_tokens: 1024,
      system: systemPrompt,
      messages: historyMessages,
      tools,
    });
  }

  const fullText = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  // Save full response as one entry in conversation history (text placeholder for images)
  const savedUserContent = mediaData
    ? `[File: ${mediaLabel(mediaData.mimeType)}] ${message}`.trim()
    : message;
  convo.messages.push({ role: 'user', content: savedUserContent });
  convo.messages.push({ role: 'assistant', content: fullText });
  if (convo.messages.length > MAX_CONVERSATION_MESSAGES) {
    convo.messages = convo.messages.slice(-MAX_CONVERSATION_MESSAGES);
  }
  convo.updated_at = new Date().toISOString();
  await saveConversation(phone, convo);

  // Background: extract durable facts for long-term memory (non-blocking)
  // Skip extraction for intents unlikely to contain memorable facts
  const skipExtraction = ['canvas-sync', 'quiet', 'reconnect', 'out-of-scope'].includes(intent);
  if (!skipExtraction) {
    extractMemory(phone, message, fullText).catch((err) =>
      console.error('Memory extraction error:', err)
    );
  }

  return splitResponse(fullText);
}

/**
 * Build the system prompt with student context.
 */
async function buildSystemPrompt(phone, profile, soul, userMessage = '') {
  const state = await getAcademicState(phone);
  const calConnected = profile.calendar_connected;
  const now = new Date();

  let context = `${soul}\n\n`;
  context += `## CURRENT STATE — source of truth, overrides anything in conversation history\n`;
  if (profile.canvas_connected === false) {
    context += `Canvas: NOT CONNECTED. Student chose to skip Canvas. You can't pull assignments or grades automatically. Instead, rely on deadlines the student tells you about (use the manage_deadlines tool). Don't nag them to connect Canvas.\n`;
  } else {
    context += `Canvas: CONNECTED to ${profile.school} (${profile.canvas_url}). ${state.courses.length} courses loaded, ${state.assignments.length} assignments tracked. Setup is COMPLETE. Never ask the student to reconnect, paste a token, or set up Canvas — it's already done.\n`;
  }
  context += `Calendar: ${calConnected ? 'CONNECTED' : 'not connected'}\n\n`;
  context += `## Student\n`;
  context += `- Name: ${profile.name}\n`;
  context += `- Your name: ${profile.buddy_name || 'StudyClaw'}\n`;
  context += `- Vibe: ${profile.vibe || 'chill'} (adapt your tone to match the "${profile.vibe || 'chill'}" personality vibe described above)\n`;
  context += `- School: ${profile.school}\n`;
  context += `- Timezone: ${profile.timezone}\n`;
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

  // Custom deadlines (student-added, not from Canvas)
  const customData = await getCustomDeadlines(phone);
  if (customData.deadlines.length > 0) {
    context += `## Student-Added Deadlines (not from Canvas)\n`;
    for (const d of customData.deadlines) {
      context += `- ${d.course || 'General'} — ${d.name}, ${d.date}${d.type ? ` (${d.type})` : ''}\n`;
    }
    context += '\n';
  }

  // Long-term memory — semantic search if available, otherwise full curated
  const memory = userMessage
    ? await searchMemory(phone, userMessage)
    : await getCuratedMemory(phone);
  if (memory) {
    context += `## Things I Know About This Student\n`;
    context += `${memory}\n\n`;
  }

  if (!calConnected) {
    const token = generateSetupToken(phone);
    const baseUrl = process.env.WEB_BASE_URL || 'https://studyclaw.com';
    context += `## Calendar Setup Link\n`;
    context += `If the student wants to connect their calendar, share this link: ${baseUrl}/connect/calendar/${token}\n\n`;
  }

  return context;
}

/**
 * Complete onboarding without Canvas. Student can still use calendar,
 * custom deadlines, effort estimation, and general study buddy features.
 */
async function skipCanvasSetup(phone, profile, soul, message) {
  profile.canvas_connected = false;
  profile.calendar_connected = await hasCalendar(phone);
  profile.preferences = {
    wake_time: '08:00',
    sleep_time: '23:00',
    morning_brief: true,
    deadline_nudges: true,
    grade_notifications: false,
    weekly_preview: true,
  };
  profile.onboarding_step = 'calendar';
  await saveProfile(phone, profile);

  return await composeOnboardingResponse(soul, {
    phone,
    studentName: profile.name,
    studentMessage: message,
    vibe: profile.vibe,
    buddyName: profile.buddy_name,
    instructions: `No Canvas — totally fine! Let them know what you CAN still do without it: track deadlines they tell you about, help plan study sessions, send you a photo of their syllabus and you'll pull out the dates, and just be someone to text when school gets heavy. They can always connect Canvas later if they want.\n\nMention your check-ins: you'll send a morning brief each day with what's due and any commitments they made, deadline reminders when things are coming up, and a weekly preview on Sundays to help them plan ahead. They can adjust any of this anytime.\n\nThen pitch connecting their calendar — if they connect it, you can see when they're actually free, find real study time slots that work around their schedule, and even add study blocks to their calendar so they don't forget. Ask what calendar app they use. Use your ${profile.vibe} vibe.`,
  });
}

/**
 * Handle the multi-step onboarding conversation.
 * Uses the state machine for flow control, Claude for message composition.
 */
async function handleOnboarding(phone, message, existingProfile) {
  const soul = await getSoulPrompt();
  const profile = existingProfile || { phone };

  // Step 1: No profile — greeting
  if (!existingProfile) {
    await saveProfile(phone, { phone, onboarding_step: 'name' });
    return await composeOnboardingResponse(soul, {
      phone,
      studentMessage: message,
      instructions: 'Introduce yourself — you\'re a study buddy that lives in their texts. You help track deadlines, plan study time, and make sure nothing sneaks up on them. Ask for their first name. Follow the "Meeting Someone New" section of your personality. Keep it warm and real.',
    });
  }

  const step = profile.onboarding_step || 'name';

  // --- Phase 1: Meet ---

  if (step === 'name') {
    const capitalized = await extractName(message);
    profile.name = capitalized;
    profile.onboarding_step = 'about';
    await saveProfile(phone, profile);
    return await composeOnboardingResponse(soul, {
      phone,
      studentName: capitalized,
      studentMessage: message,
      instructions: `Their name is ${capitalized}. Greet them by name. Now get to know them — ask what year they are and what they're studying. Be genuinely curious, like you actually care. Don't rush to the setup stuff yet.`,
    });
  }

  if (step === 'about') {
    // Save what they told us about themselves to memory
    extractMemory(phone, message, '').catch(() => {});

    profile.vibe = 'chill';
    profile.buddy_name = 'StudyClaw';
    profile.onboarding_step = 'school';
    await saveProfile(phone, profile);
    return await composeOnboardingResponse(soul, {
      phone,
      studentName: profile.name,
      studentMessage: message,
      instructions: `The student just told you about themselves (year, major, how things are going). React to what they said — be genuinely interested. Then naturally transition to connecting their school so you can see their assignments. Ask what school they go to. Frame it as "let me connect to your school so I can see what you've got going on" not "provide your institutional credentials."`,
    });
  }

  // --- Phase 2: Connect ---

  // Detect "I don't use Canvas / no LMS" at any point during connect phase
  if ((step === 'school' || step === 'school_url' || step === 'token') &&
      /\b(don'?t (use|have)|no canvas|not on canvas|no lms|skip|don'?t have (an? )?(lms|canvas)|blackboard|brightspace|moodle|d2l|schoology)\b/i.test(message)) {
    return await skipCanvasSetup(phone, profile, soul, message);
  }

  if (step === 'school') {
    const schools = await getSchools();
    const input = message.trim();
    let matched = null;
    const inputLower = input.toLowerCase();

    for (const [name, data] of Object.entries(schools)) {
      const nameLower = name.toLowerCase();
      if (inputLower.includes(nameLower) || nameLower.includes(inputLower)) {
        matched = { name, ...data };
        break;
      }
      if (data.aliases) {
        for (const alias of data.aliases) {
          const aliasLower = alias.toLowerCase();
          if (inputLower === aliasLower || inputLower.includes(aliasLower) || aliasLower.includes(inputLower)) {
            matched = { name, ...data };
            break;
          }
        }
        if (matched) break;
      }
    }

    if (!matched) {
      let bestScore = Infinity;
      for (const [name, data] of Object.entries(schools)) {
        const candidates = [name, ...(data.aliases || [])];
        for (const candidate of candidates) {
          const dist = levenshtein(inputLower, candidate.toLowerCase());
          if (dist < bestScore && dist <= 3) {
            bestScore = dist;
            matched = { name, ...data };
          }
          const truncated = candidate.toLowerCase().slice(0, inputLower.length);
          const prefixDist = levenshtein(inputLower, truncated);
          if (prefixDist < bestScore && prefixDist <= 2 && inputLower.length >= 4) {
            bestScore = prefixDist;
            matched = { name, ...data };
          }
        }
      }
    }

    if (matched) {
      profile.school = matched.name;
      profile.canvas_url = matched.canvas_url;
      profile.timezone = matched.timezone;
      profile.onboarding_step = 'token';
      await saveProfile(phone, profile);
      return await composeOnboardingResponse(soul, {
        studentName: profile.name,
        studentMessage: message,
        vibe: profile.vibe,
        instructions: `They go to ${matched.name}. Their Canvas is at ${matched.canvas_url} (called "${matched.nickname}"). Walk them through getting an access token so you can see their courses. Steps: 1) Open ${matched.canvas_url} and log in, 2) Profile icon → Settings, 3) Scroll to "Approved Integrations", 4) "+ New Access Token", 5) Name it anything, tap Generate, 6) Copy and paste it back here. Frame it as "this takes like 30 seconds" and reassure them you can only read their assignments. Use your ${profile.vibe} vibe.`,
      });
    }

    profile.onboarding_step = 'school_url';
    await saveProfile(phone, profile);
    return await composeOnboardingResponse(soul, {
      phone,
      studentName: profile.name,
      studentMessage: message,
      vibe: profile.vibe,
      instructions: `Couldn't find their school. Ask for the website where they check assignments — usually looks like canvas.something.edu or something.instructure.com. Don't make them feel bad about it.`,
    });
  }

  if (step === 'school_url') {
    const input = message.trim();
    const urlMatch = input.match(/(https?:\/\/[^\s]+|[\w.-]+\.(edu|com)[^\s]*)/i);
    if (urlMatch) {
      let url = urlMatch[0];
      if (!url.startsWith('http')) url = `https://${url}`;
      if (!/canvas|instructure|bcourses|bruinlearn|courseworks/i.test(url)) {
        return await composeOnboardingResponse(soul, {
          studentName: profile.name,
          studentMessage: message,
          vibe: profile.vibe,
          instructions: `The URL "${url}" doesn't look like Canvas. You only work with Canvas right now — not Blackboard, Brightspace, or Moodle. Let them know gently. If they have a Canvas URL they can paste it. If not, they can say "skip" and you'll still help with deadlines, study planning, and calendar stuff — just won't be able to pull assignments automatically.`,
        });
      }
      profile.school = input;
      profile.canvas_url = url;
      profile.timezone = 'America/New_York';
      profile.onboarding_step = 'token';
      await saveProfile(phone, profile);
      return await composeOnboardingResponse(soul, {
        studentName: profile.name,
        studentMessage: message,
        vibe: profile.vibe,
        instructions: `Got their Canvas URL: ${url}. Walk them through generating a token. Steps: 1) Open ${url} and log in, 2) Profile → Settings, 3) "Approved Integrations", 4) "+ New Access Token", 5) Name it anything, Generate, 6) Copy and paste back. Keep it easy.`,
      });
    }
    return await composeOnboardingResponse(soul, {
      phone,
      studentName: profile.name,
      studentMessage: message,
      vibe: profile.vibe,
      instructions: `No URL found in their message. They might be confused. Help them find where they check assignments — it's usually canvas.something.edu. Be patient.`,
    });
  }

  if (step === 'token') {
    const token = message.trim();

    // A token is a long alphanumeric string with no spaces (often contains ~)
    // Natural language has spaces and common words — always classify those
    const looksLikeToken = token.length >= 20 && !/\s/.test(token);

    if (!looksLikeToken) {
      // Short message — classify intent before assuming it's a bad token
      const looksLikeSchool = token.length < 20 && /[a-zA-Z]{3,}/.test(token) && !/^\d/.test(token);
      if (looksLikeSchool) {
        // Could be correcting their school — route back
        const intentCheck = await classifyTokenIntent(message);
        if (intentCheck === 'school') {
          profile.onboarding_step = 'school';
          profile.token_attempts = 0;
          await saveProfile(phone, profile);
          return await handleOnboarding(phone, message, profile);
        }
      }

      const intent = await classifyTokenIntent(message);

      if (intent === 'help') {
        // They're confused or want instructions again
        return await composeOnboardingResponse(soul, {
          phone,
          studentName: profile.name,
          studentMessage: message,
          vibe: profile.vibe,
          instructions: `They need help with the token step. Walk them through it again, simply: 1) Open ${profile.canvas_url} in a browser and log in, 2) Tap your profile icon → Settings, 3) Scroll down to "Approved Integrations", 4) Click "+ New Access Token", 5) Name it anything (like "StudyClaw"), tap Generate, 6) Copy that long string and paste it back here. Reassure them it only takes 30 seconds and you can only see assignments, not change anything. Use your ${profile.vibe} vibe.`,
        });
      }

      if (intent === 'later') {
        // They want to do it later — skip Canvas for now
        return await skipCanvasSetup(phone, profile, soul, message);
      }

      if (intent === 'chat') {
        // Natural conversation, not a token attempt — respond naturally and gently steer back
        return await composeOnboardingResponse(soul, {
          phone,
          studentName: profile.name,
          studentMessage: message,
          vibe: profile.vibe,
          instructions: `They're chatting, not giving a token. Respond naturally to what they said, then gently remind them about the Canvas token when it feels right — no rush. If they seem stuck or uninterested, let them know they can always do it later by saying "skip". Use your ${profile.vibe} vibe.`,
        });
      }

      // intent === 'token' but too short — they probably pasted a partial token
      return await composeOnboardingResponse(soul, {
        studentName: profile.name,
        studentMessage: message,
        vibe: profile.vibe,
        instructions: `That looks like it might be a token but it's too short — they probably didn't copy the whole thing. Canvas tokens are long strings, usually with a ~ in them. Ask them to try copying it again.`,
      });
    }

    // Looks like an actual token attempt — validate it
    try {
      const client = new CanvasClient(profile.canvas_url, token);
      await client.validateToken();
      const { courses, assignments } = await client.fullSync();
      await saveCanvasToken(phone, token);
      await saveAcademicState(phone, { courses, assignments, last_sync: new Date().toISOString() });
      profile.onboarding_step = 'confirm_courses';
      await saveProfile(phone, profile);
      const courseList = courses.map((c) => c.name).join(', ');
      return await composeOnboardingResponse(soul, {
        studentName: profile.name,
        studentMessage: message,
        vibe: profile.vibe,
        instructions: `Connected! Found ${courses.length} courses: ${courseList}. Show them the list and ask if it looks right. Be excited — this is the moment it becomes real. Use your ${profile.vibe} vibe.`,
      });
    } catch (err) {
      if (!profile.token_attempts) profile.token_attempts = 0;
      profile.token_attempts++;
      await saveProfile(phone, profile);
      return await composeOnboardingResponse(soul, {
        studentName: profile.name,
        studentMessage: message,
        vibe: profile.vibe,
        instructions: `Token didn't work (attempt ${profile.token_attempts}). ${profile.token_attempts >= 2 ? `They've tried multiple times. Suggest checking they're on ${profile.canvas_url} and the token was just created. Or they can say "skip" and connect later.` : "Encourage them to try again — maybe they didn't copy the whole thing."}`,
      });
    }
  }

  // --- Phase 3: Deliver value ---

  if (step === 'confirm_courses') {
    const confirmed = await classifyYesNo(message);
    if (confirmed) {
      // Canvas connected — set preferences, show value, then ask about calendar
      profile.calendar_connected = await hasCalendar(phone);
      profile.preferences = {
        wake_time: '08:00',
        sleep_time: '23:00',
        morning_brief: true,
        deadline_nudges: true,
        grade_notifications: true,
        weekly_preview: true,
      };
      profile.onboarding_step = 'calendar';
      await saveProfile(phone, profile);

      // Show upcoming assignments — the magic moment
      const state = await getAcademicState(phone);
      const now = new Date();
      const upcoming = state.assignments
        .filter((a) => !a.submitted && new Date(a.due_at) > now)
        .slice(0, 5);

      const assignmentSummary = upcoming.length > 0
        ? upcoming.map((a) => {
            const due = new Date(a.due_at).toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
              timeZone: profile.timezone,
            });
            return `${a.course_name} — ${a.name}, due ${due}`;
          }).join('\n')
        : 'No upcoming assignments found right now.';

      return await composeOnboardingResponse(soul, {
        phone,
        studentName: profile.name,
        studentMessage: message,
        vibe: profile.vibe,
        buddyName: profile.buddy_name,
        instructions: `You're all set up! Show them what's coming up:\n\n${assignmentSummary}\n\nPresent it naturally. Tell them they can text you anytime — ask what's due, get help planning, send a syllabus photo, etc.\n\nMention your check-ins: you'll send a morning brief each day with what's due and any commitments they made, deadline reminders when things are coming up, and a weekly preview on Sundays to help them plan ahead. They can adjust any of this anytime.\n\nThen pitch connecting their calendar — if they connect it, you can see when they're actually free, find real study time slots that work around their schedule, and even add study blocks to their calendar so they don't forget. Ask what calendar app they use. Use your ${profile.vibe} vibe.`,
      });
    }

    profile.onboarding_step = 'token';
    profile.token_attempts = 0;
    await saveProfile(phone, profile);
    return await composeOnboardingResponse(soul, {
      phone,
      studentName: profile.name,
      studentMessage: message,
      vibe: profile.vibe,
      instructions: `Courses didn't look right. Ask them to try a new token. Maybe wrong account or something got mixed up.`,
    });
  }

  // --- Phase 4: Calendar ---

  if (step === 'calendar') {
    const calType = await classifyCalendarType(message);
    const calToken = generateSetupToken(phone);
    const baseUrl = process.env.WEB_BASE_URL || 'https://studyclaw.com';
    const calLink = `${baseUrl}/connect/calendar/${calToken}`;

    if (calType === 'skip') {
      profile.onboarding_step = 'complete';
      profile.setup_complete = true;
      await saveProfile(phone, profile);
      await saveConversation(phone, { messages: [], updated_at: new Date().toISOString() });
      return await composeOnboardingResponse(soul, {
        phone,
        studentName: profile.name,
        studentMessage: message,
        vibe: profile.vibe,
        buddyName: profile.buddy_name,
        instructions: `No calendar — no problem. Wrap up onboarding. Let them know they're all set and can text you anytime. They can always connect their calendar later. Keep it brief and use your ${profile.vibe} vibe.`,
      });
    }

    profile.onboarding_step = 'calendar_done';
    await saveProfile(phone, profile);

    if (calType === 'apple') {
      return await composeOnboardingResponse(soul, {
        phone,
        studentName: profile.name,
        studentMessage: message,
        vibe: profile.vibe,
        buddyName: profile.buddy_name,
        instructions: `They use Apple Calendar. You connect through Google Calendar, but the good news is they work together perfectly. Walk them through it casually:\n\n1. On their iPhone: Settings > Calendar > Accounts > Add Account > Google\n2. Sign in with their Google account and make sure Calendar is toggled on\n3. Then tap this link to connect: ${calLink}\n\nOnce both are connected, everything syncs — their Apple Calendar events show up in Google and vice versa, so you'll see their full schedule. If they already have a Google account linked, they can skip straight to the link. Use your ${profile.vibe} vibe.`,
      });
    }

    // Google Calendar (or default)
    return await composeOnboardingResponse(soul, {
      phone,
      studentName: profile.name,
      studentMessage: message,
      vibe: profile.vibe,
      buddyName: profile.buddy_name,
      instructions: `They use Google Calendar — perfect, that's exactly what you connect to. Share this link to connect: ${calLink}\n\nOnce they tap it and sign in, you'll be able to see their schedule, find free time for studying, and add study blocks right to their calendar. Use your ${profile.vibe} vibe.`,
    });
  }

  if (step === 'calendar_done') {
    const calResponse = await classifyCalendarResponse(message);

    if (calResponse === 'done') {
      profile.calendar_connected = await hasCalendar(phone);
      profile.setup_complete = true;
      profile.onboarding_step = 'complete';
      await saveProfile(phone, profile);
      await saveConversation(phone, { messages: [], updated_at: new Date().toISOString() });
      return await composeOnboardingResponse(soul, {
        phone,
        studentName: profile.name,
        studentMessage: message,
        vibe: profile.vibe,
        buddyName: profile.buddy_name,
        instructions: `${profile.calendar_connected ? "Calendar connected!" : "Hmm, I don't see the connection yet — but that's fine, it might take a sec."} Either way, you're all set! Let them know they can text you anytime. Keep it brief and warm. Use your ${profile.vibe} vibe.`,
      });
    }

    if (calResponse === 'confused') {
      const calToken = generateSetupToken(phone);
      const baseUrl = process.env.WEB_BASE_URL || 'https://studyclaw.com';
      const calLink = `${baseUrl}/connect/calendar/${calToken}`;
      return await composeOnboardingResponse(soul, {
        phone,
        studentName: profile.name,
        studentMessage: message,
        vibe: profile.vibe,
        buddyName: profile.buddy_name,
        instructions: `They seem confused about the calendar step. Keep it simple — just tap this link and sign in with Google: ${calLink}\n\nIf they don't want to do it right now, that's totally fine — they can always do it later. Use your ${profile.vibe} vibe.`,
      });
    }

    // skip
    profile.setup_complete = true;
    profile.onboarding_step = 'complete';
    await saveProfile(phone, profile);
    await saveConversation(phone, { messages: [], updated_at: new Date().toISOString() });
    return await composeOnboardingResponse(soul, {
      phone,
      studentName: profile.name,
      studentMessage: message,
      vibe: profile.vibe,
      buddyName: profile.buddy_name,
      instructions: `No worries on the calendar — they can always connect later. Wrap up onboarding. Let them know they're all set and can text you anytime. Keep it brief. Use your ${profile.vibe} vibe.`,
    });
  }

  profile.onboarding_step = 'name';
  await saveProfile(phone, profile);
  return await composeOnboardingResponse(soul, {
    studentMessage: message,
    instructions: 'Something got lost. Apologize briefly and ask for their name to start over.',
  });
}

/**
 * Use Claude to compose an onboarding response.
 * Keeps the tone natural and handles off-script messages.
 */
/**
 * Background: extract durable facts from a conversation turn and save to memory.
 * Uses Haiku for cost efficiency since this runs after every message.
 */
async function extractMemory(phone, userMessage, assistantMessage) {
  // Load curated memory + today's daily file for dedup (not all history)
  const curated = await getCuratedMemory(phone);
  const todayNotes = await getRecentMemory(phone, 1);
  const existing = [curated, todayNotes].filter(Boolean).join('\n');
  const today = new Date().toISOString().split('T')[0];

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Student said: "${userMessage}"
StudyClaw replied: "${assistantMessage}"
Today's date: ${today}

${existing ? `Existing memory:\n${existing}\n` : ''}
Do TWO things:

1. FACTS: Extract any NEW durable facts worth remembering. Include preferences, schedule constraints, personal details, habits, progress, wins, patterns. Only facts NOT already in existing memory. Write each as a bullet point.

2. COMMITMENTS: Did the student commit to doing something? ("I'll start the essay tonight", "I'm gonna do it tomorrow", "I'll work on it this weekend") If yes, write each as:
COMMITMENT: <what they'll do> | <due date if mentioned, otherwise blank>

Also check: did the student indicate they COMPLETED a previous commitment? ("I finished the lab", "done with the essay", "turned it in") If yes, write:
COMPLETED: <what they finished>

If there are no new facts AND no commitments, respond with exactly: NONE`,
    }],
  });

  const result = response.content[0].text.trim();
  if (result === 'NONE' || result.length <= 5) return;

  // Parse commitments from the response
  const lines = result.split('\n');
  const factLines = [];
  const newCommitments = [];
  const completedTexts = [];

  for (const line of lines) {
    const commitMatch = line.match(/^COMMITMENT:\s*(.+?)(?:\s*\|\s*(.+))?$/);
    const completedMatch = line.match(/^COMPLETED:\s*(.+)$/);
    if (commitMatch) {
      newCommitments.push({
        status: 'pending',
        text: commitMatch[1].trim(),
        committed: today,
        due: commitMatch[2]?.trim() || null,
      });
    } else if (completedMatch) {
      completedTexts.push(completedMatch[1].trim().toLowerCase());
    } else if (line.trim().startsWith('-') || line.trim().length > 5) {
      factLines.push(line);
    }
  }

  // Save facts to daily memory
  const facts = factLines.join('\n').trim();
  if (facts) {
    await appendMemory(phone, facts);
  }

  // Update commitments
  if (newCommitments.length > 0 || completedTexts.length > 0) {
    const existing = await getCommitments(phone);

    // Mark completed commitments
    for (const c of existing) {
      if (c.status === 'pending' && completedTexts.some((t) => c.text.toLowerCase().includes(t) || t.includes(c.text.toLowerCase()))) {
        c.status = 'completed';
      }
    }

    // Add new commitments
    existing.push(...newCommitments);

    await updateCommitments(phone, existing);
  }
}

async function composeOnboardingResponse(soul, context) {
  const phone = context.phone;

  // Load conversation history so onboarding feels continuous
  let historyMessages = [];
  if (phone) {
    const convo = await getConversation(phone);
    historyMessages = convo.messages.slice(-MAX_CONVERSATION_MESSAGES);
  }

  // Add the current instruction as a user message
  historyMessages.push({
    role: 'user',
    content: `[INTERNAL — the student said: "${context.studentMessage}"]\n\n${context.instructions}${context.studentName ? `\n\nStudent's name: ${context.studentName}` : ''}`,
  });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: `${soul}\n\n## Onboarding Context\nYou are guiding a student through first-time setup. Respond naturally — brief, casual, helpful. This is a text message conversation. The messages marked [INTERNAL] contain instructions for you — respond to the student naturally based on them. Do NOT reference the internal instructions in your response.`,
    messages: historyMessages,
  });

  const assistantText = response.content[0].text;

  // Save both sides to conversation history
  if (phone) {
    const convo = await getConversation(phone);
    convo.messages.push({ role: 'user', content: context.studentMessage });
    convo.messages.push({ role: 'assistant', content: assistantText });
    if (convo.messages.length > MAX_CONVERSATION_MESSAGES) {
      convo.messages = convo.messages.slice(-MAX_CONVERSATION_MESSAGES);
    }
    convo.updated_at = new Date().toISOString();
    await saveConversation(phone, convo);
  }

  return assistantText;
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
 * Split a response on --- separators into multiple messages.
 */
/**
 * Use Claude to classify if a message means yes/confirmed or no/denied.
 * Fast Haiku call — more flexible than regex for natural language.
 */
/**
 * Execute a planning tool call and return the result.
 */
async function executeTool(name, input, phone, profile) {
  try {
    if (name === 'get_calendar_events') {
      const tokens = await getGCalTokens(phone);
      if (!tokens) return { error: 'Calendar not connected. Student can connect at the calendar setup link.' };
      const events = await getEvents(tokens, new Date(input.start_date), new Date(input.end_date));
      return { events };
    }

    if (name === 'find_study_slots') {
      const tokens = await getGCalTokens(phone);
      let events = [];
      if (tokens) {
        events = await getEvents(tokens, new Date(input.start_date), new Date(input.end_date));
      }
      const slots = findSlots(events, {
        rangeStart: new Date(input.start_date),
        rangeEnd: new Date(input.end_date),
        durationHours: input.duration_hours,
        timezone: profile.timezone || 'America/New_York',
        wakeHour: parseInt(profile.preferences?.wake_time?.split(':')[0]) || 8,
        sleepHour: parseInt(profile.preferences?.sleep_time?.split(':')[0]) || 23,
        urgent: input.urgent || false,
      });
      const ranked = rankSlots(slots, 8);
      return {
        available_slots: ranked.map((s) => ({
          start: s.start.toISOString(),
          end: s.end.toISOString(),
          label: s.label,
        })),
        calendar_connected: !!tokens,
      };
    }

    if (name === 'estimate_effort') {
      const history = await getEffortHistory(phone);
      const result = estimateEffort(
        {
          assignment_type: input.assignment_type,
          course_id: input.course_id,
        },
        history
      );
      return {
        estimated_hours: result.hours,
        label: result.label,
        source: result.source,
      };
    }

    if (name === 'get_planner') {
      const token = await getCanvasToken(phone);
      if (!token) return { error: 'Canvas not connected' };
      const client = new CanvasClient(profile.canvas_url, token);
      const now = new Date();
      const start = input.start_date ? new Date(input.start_date) : now;
      const end = input.end_date ? new Date(input.end_date) : new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      return { items: await client.getPlannerItems(start, end) };
    }

    if (name === 'get_grades') {
      const token = await getCanvasToken(phone);
      if (!token) return { error: 'Canvas not connected' };
      const client = new CanvasClient(profile.canvas_url, token);
      return { enrollments: await client.getEnrollments() };
    }

    if (name === 'get_course_detail') {
      const token = await getCanvasToken(phone);
      if (!token) return { error: 'Canvas not connected' };
      const client = new CanvasClient(profile.canvas_url, token);
      const include = input.include || ['announcements'];
      const result = {};
      const state = await getAcademicState(phone);

      const tryFetch = async (fn) => { try { return await fn(); } catch { return []; } };

      if (include.includes('announcements')) {
        const courseIds = input.course_id ? [input.course_id] : state.courses.map((c) => c.id);
        result.announcements = await tryFetch(() => client.getAnnouncements(courseIds));
      }
      if (include.includes('discussions')) {
        result.discussions = await tryFetch(() => client.getDiscussionTopics(input.course_id));
      }
      if (include.includes('quizzes')) {
        result.quizzes = await tryFetch(() => client.getQuizzes(input.course_id));
      }
      if (include.includes('rubrics')) {
        result.rubrics = await tryFetch(() => client.getRubrics(input.course_id));
      }
      if (include.includes('files')) {
        result.files = await tryFetch(() => client.getCourseFiles(input.course_id));
      }
      if (include.includes('conferences')) {
        result.conferences = await tryFetch(() => client.getConferences(input.course_id));
      }
      if (include.includes('syllabus')) {
        try {
          const { syllabus_body } = await client.getSyllabus(input.course_id);
          result.syllabus = syllabus_body ? syllabus_body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000) : 'Professor has not posted syllabus content in Canvas.';
        } catch {
          result.syllabus = 'Syllabus not available for this course through Canvas.';
        }
      }
      if (include.includes('modules')) {
        result.modules = await tryFetch(() => client.getModules(input.course_id));
      }
      if (include.includes('events')) {
        try {
          const now = new Date();
          const semesterEnd = new Date(now);
          semesterEnd.setMonth(semesterEnd.getMonth() + 4);
          const courseIds = input.course_id ? [input.course_id] : state.courses.map((c) => c.id);
          result.events = await client.getCalendarEvents(courseIds, now, semesterEnd);
        } catch {
          result.events = [];
        }
      }
      return result;
    }

    if (name === 'get_feedback') {
      const token = await getCanvasToken(phone);
      if (!token) return { error: 'Canvas not connected' };
      const client = new CanvasClient(profile.canvas_url, token);
      return await client.getSubmissionComments(input.course_id, input.assignment_id);
    }

    if (name === 'get_groups') {
      const token = await getCanvasToken(phone);
      if (!token) return { error: 'Canvas not connected' };
      const client = new CanvasClient(profile.canvas_url, token);
      if (input.group_id) {
        const members = await client.getGroupMembers(input.group_id);
        return { members };
      }
      return { groups: await client.getGroups() };
    }

    if (name === 'manage_deadlines') {
      const data = await getCustomDeadlines(phone);
      if (input.action === 'list') {
        return { deadlines: data.deadlines };
      }
      if (input.action === 'add') {
        data.deadlines.push({
          name: input.name,
          course: input.course || 'General',
          date: input.date,
          type: input.type || 'other',
          added_at: new Date().toISOString(),
        });
        await saveCustomDeadlines(phone, data);
        return { added: true, total: data.deadlines.length };
      }
      if (input.action === 'edit') {
        const match = data.deadlines.find(
          (d) => d.name.toLowerCase().includes(input.name.toLowerCase())
        );
        if (!match) return { error: `No deadline found matching "${input.name}"` };
        if (input.date) match.date = input.date;
        if (input.course) match.course = input.course;
        if (input.type) match.type = input.type;
        await saveCustomDeadlines(phone, data);
        return { updated: true, deadline: match };
      }
      if (input.action === 'remove') {
        const before = data.deadlines.length;
        data.deadlines = data.deadlines.filter(
          (d) => !d.name.toLowerCase().includes(input.name.toLowerCase())
        );
        await saveCustomDeadlines(phone, data);
        return { removed: before - data.deadlines.length, remaining: data.deadlines.length };
      }
      return { error: 'Unknown action' };
    }

    if (name === 'search_course_files') {
      const token = await getCanvasToken(phone);
      if (!token) return { error: 'Canvas not connected' };
      const client = new CanvasClient(profile.canvas_url, token);

      if (input.read_file_id) {
        // Download and read file content
        try {
          const fileInfo = await client._fetch(`/files/${input.read_file_id}`);
          const fileUrl = fileInfo.url;
          const res = await fetch(fileUrl);
          if (fileInfo.content_type === 'application/pdf') {
            const buffer = await res.arrayBuffer();
            const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
            const pdf = await pdfParse(Buffer.from(buffer));
            return {
              filename: fileInfo.display_name,
              content_type: 'pdf',
              text: pdf.text.substring(0, 4000),
              pages: pdf.numpages,
            };
          }
          // For text/html files
          const text = await res.text();
          return {
            filename: fileInfo.display_name,
            content_type: fileInfo.content_type,
            text: text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 4000),
          };
        } catch (err) {
          return { error: `Could not read file: ${err.message}` };
        }
      }

      // Search for files
      try {
        const files = await client.getCourseFiles(input.course_id, input.search_term || 'syllabus');
        return {
          files: files.map((f) => ({
            id: f.id,
            name: f.name,
            type: f.content_type,
            size: f.size,
            updated: f.updated_at,
          })),
        };
      } catch {
        return { files: [], note: 'Could not access files for this course.' };
      }
    }

    if (name === 'build_study_plan') {
      const state = await getAcademicState(phone);
      const history = await getEffortHistory(phone);
      const now = new Date();
      const daysAhead = input.days_ahead || 7;
      const rangeEnd = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

      const upcoming = state.assignments.filter(
        (a) => !a.submitted && new Date(a.due_at) > now && new Date(a.due_at) <= rangeEnd
      );

      if (upcoming.length === 0) {
        return { plan: [], message: 'No assignments due in the next ' + daysAhead + ' days.' };
      }

      const prioritized = prioritizeAssignments(upcoming, history);

      let events = [];
      const tokens = await getGCalTokens(phone);
      if (tokens) {
        try {
          events = await getEvents(tokens, now, rangeEnd);
        } catch { /* calendar unavailable */ }
      }

      const plan = buildStudyPlan(prioritized, events, {
        timezone: profile.timezone || 'America/New_York',
        wakeHour: parseInt(profile.preferences?.wake_time?.split(':')[0]) || 8,
        sleepHour: parseInt(profile.preferences?.sleep_time?.split(':')[0]) || 23,
      });

      return {
        plan: plan.map((p) => ({
          assignment: p.assignment.name,
          course: p.assignment.course_name,
          due: p.assignment.due_at,
          estimated_hours: p.effort.hours,
          effort_label: p.effort.label,
          scheduled_slot: p.slot.label,
          slot_start: p.slot.start.toISOString(),
          slot_end: p.slot.end.toISOString(),
          urgency: prioritized.find((x) => x.assignment.id === p.assignment.id)?.priority.urgency,
        })),
        calendar_connected: !!tokens,
        unscheduled: prioritized
          .filter((p) => !plan.find((s) => s.assignment.id === p.assignment.id))
          .map((p) => ({ assignment: p.assignment.name, course: p.assignment.course_name, reason: 'No available slot found' })),
      };
    }

    if (name === 'update_preferences') {
      if (!profile.preferences) profile.preferences = {};
      const updated = [];
      if (input.wake_time !== undefined) { profile.preferences.wake_time = input.wake_time; updated.push('wake_time'); }
      if (input.sleep_time !== undefined) { profile.preferences.sleep_time = input.sleep_time; updated.push('sleep_time'); }
      if (input.morning_brief !== undefined) { profile.preferences.morning_brief = input.morning_brief; updated.push('morning_brief'); }
      if (input.deadline_nudges !== undefined) { profile.preferences.deadline_nudges = input.deadline_nudges; updated.push('deadline_nudges'); }
      if (input.grade_notifications !== undefined) { profile.preferences.grade_notifications = input.grade_notifications; updated.push('grade_notifications'); }
      if (input.weekly_preview !== undefined) { profile.preferences.weekly_preview = input.weekly_preview; updated.push('weekly_preview'); }
      if (input.buddy_name !== undefined) { profile.buddy_name = input.buddy_name; updated.push('buddy_name'); }
      if (input.vibe !== undefined) { profile.vibe = input.vibe; updated.push('vibe'); }
      await saveProfile(phone, profile);
      return { updated: updated, preferences: profile.preferences, vibe: profile.vibe, buddy_name: profile.buddy_name };
    }

    if (name === 'create_calendar_event') {
      const tokens = await getGCalTokens(phone);
      if (!tokens) return { error: 'Calendar not connected.' };
      const event = await createStudyEvent(tokens, {
        eventTitle: input.event_title,
        dueDate: input.due_date || '',
        startTime: input.start_time,
        endTime: input.end_time,
        timezone: profile.timezone || 'America/New_York',
      });
      return { created: true, event_id: event.id, summary: event.summary };
    }

    if (name === 'edit_calendar_event') {
      const tokens = await getGCalTokens(phone);
      if (!tokens) return { error: 'Calendar not connected.' };
      const event = await updateCalendarEvent(tokens, {
        eventId: input.event_id,
        eventTitle: input.event_title,
        startTime: input.start_time,
        endTime: input.end_time,
        timezone: profile.timezone || 'America/New_York',
      });
      return { updated: true, event_id: event.id, summary: event.summary };
    }

    if (name === 'delete_calendar_event') {
      const tokens = await getGCalTokens(phone);
      if (!tokens) return { error: 'Calendar not connected.' };
      await deleteCalendarEvent(tokens, input.event_id);
      return { deleted: true };
    }

    return { error: `Unknown tool: ${name}` };
  } catch (err) {
    console.error(`Tool ${name} error:`, err);

    const CALENDAR_TOOLS = ['get_calendar_events', 'create_calendar_event', 'edit_calendar_event', 'delete_calendar_event'];
    const CANVAS_TOOLS = ['get_planner', 'get_grades', 'get_course_detail', 'get_feedback', 'get_groups', 'search_course_files'];

    if (CALENDAR_TOOLS.includes(name)) {
      const classified = classifyCalendarError(err);
      if (classified.type === 'auth') {
        const token = generateSetupToken(phone);
        const baseUrl = process.env.WEB_BASE_URL || 'https://studyclaw.com';
        return { error: classified.message, reconnect_link: `${baseUrl}/connect/calendar/${token}` };
      }
      return { error: classified.message };
    }

    if (CANVAS_TOOLS.includes(name)) {
      const classified = classifyCanvasError(err);
      if (classified.type === 'auth') {
        return { error: classified.message, needs_canvas_reconnect: true };
      }
      return { error: classified.message };
    }

    return { error: 'Something went wrong checking that. Try again in a sec.' };
  }
}

async function classifyYesNo(message) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{
      role: 'user',
      content: `Does this message mean "yes" or confirm something? Answer with only Y or N.\n\nMessage: "${message}"`,
    }],
  });
  return response.content[0].text.trim().toUpperCase() === 'Y';
}

async function classifyTokenIntent(message) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `A student was asked to paste a Canvas API token. Instead they sent this message. What are they doing?

Message: "${message}"

Categories:
- TOKEN: attempting to paste a token (even if partial/wrong)
- HELP: confused, asking how, wanting instructions repeated ("how do I do that", "where is it", "I don't understand")
- LATER: wants to do it later or skip ("I'll do it later", "skip", "can I do this on my laptop", "not right now", "give me a sec")
- SCHOOL: correcting their school name or giving a different school
- CHAT: natural conversation unrelated to the token ("haha", "cool", "what can you do", "that's a lot of steps")

Answer with only one word: TOKEN, HELP, LATER, SCHOOL, or CHAT.`,
    }],
  });
  return response.content[0].text.trim().toLowerCase();
}

async function classifyCalendarType(message) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `A student was asked what calendar app they use. Classify their response:
- GOOGLE (Google Calendar, gcal, or if they just say yes/sure/connect it/sounds good)
- APPLE (Apple Calendar, iCal, iPhone calendar, iOS calendar, Mac calendar)
- SKIP (don't use one, no calendar, skip, not now, nah, later, no thanks)

Reply with ONLY one word: GOOGLE, APPLE, or SKIP.

Message: "${message}"`,
    }],
  });
  const result = response.content[0].text.trim().toUpperCase();
  return ['GOOGLE', 'APPLE', 'SKIP'].includes(result) ? result.toLowerCase() : 'google';
}

async function classifyCalendarResponse(message) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `A student was offered to connect their Google Calendar (optional). They responded with: "${message}"

Classify their response as exactly one of:
- SKIP (they don't want to, want to skip, decline, "nah", "not now", "later", "i'm good", or are moving on to ask about something else)
- DONE (they claim they already connected it)
- CONFUSED (they're asking a question or seem unsure)

Reply with ONLY one word: SKIP, DONE, or CONFUSED.`,
    }],
  });
  const result = response.content[0].text.trim().toUpperCase();
  if (['SKIP', 'DONE', 'CONFUSED'].includes(result)) return result.toLowerCase();
  return 'skip'; // default to skip if unclear — don't block onboarding
}

async function extractName(message) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 20,
    messages: [{
      role: 'user',
      content: `What is this person's first name? Reply with ONLY the name, properly capitalized. Nothing else.\n\nMessage: "${message}"`,
    }],
  });
  return response.content[0].text.trim().split(/\s+/)[0];
}

async function classifyVibe(message) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `The user was asked what communication style they want. Classify their response into exactly one of these four options: chill, hype, straight, gentle.

- chill = relaxed, low-key, casual
- hype = enthusiastic, motivating, energetic
- straight = direct, no-nonsense, blunt
- gentle = patient, encouraging, soft

Reply with ONLY one word: chill, hype, straight, or gentle.

Message: "${message}"`,
    }],
  });
  const vibe = response.content[0].text.trim().toLowerCase();
  return ['chill', 'hype', 'straight', 'gentle'].includes(vibe) ? vibe : 'chill';
}

async function extractBuddyName(message) {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 20,
    messages: [{
      role: 'user',
      content: `The user was asked what they want to name their study buddy (default is "StudyClaw"). What name did they choose? If they want to keep the default or said something like "that's fine" or "studyclaw works", reply with DEFAULT. Otherwise reply with ONLY the name they chose, capitalized.

Message: "${message}"`,
    }],
  });
  const result = response.content[0].text.trim();
  return result === 'DEFAULT' ? 'StudyClaw' : result.split(/\s+/)[0];
}

function normalizeMediaType(mime) {
  const map = {
    'image/jpeg': 'image/jpeg',
    'image/jpg': 'image/jpeg',
    'image/png': 'image/png',
    'image/webp': 'image/webp',
    'image/gif': 'image/gif',
  };
  return map[mime] || 'image/jpeg';
}

function isWordDoc(mime) {
  return mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || mime === 'application/msword';
}

function isSpreadsheet(mime) {
  return mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    || mime === 'application/vnd.ms-excel';
}

function mediaLabel(mime) {
  if (mime === 'application/pdf') return 'PDF document';
  if (isWordDoc(mime)) return 'Word document';
  if (isSpreadsheet(mime)) return 'spreadsheet';
  return 'photo';
}

async function extractWordText(base64) {
  const mammoth = await import('mammoth');
  const buffer = Buffer.from(base64, 'base64');
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.substring(0, 8000);
  console.log(`[Media] Word extraction: ${text.length} chars, preview: ${text.substring(0, 200)}`);
  return text;
}

async function extractExcelText(base64) {
  const XLSX = await import('xlsx');
  const buffer = Buffer.from(base64, 'base64');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const lines = [];
  for (const sheetName of workbook.SheetNames) {
    lines.push(`--- ${sheetName} ---`);
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
    lines.push(csv);
  }
  return lines.join('\n').substring(0, 8000);
}

async function extractTokenFromImage(mediaData) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: normalizeMediaType(mediaData.mimeType),
              data: mediaData.base64,
            },
          },
          {
            type: 'text',
            text: 'This image may contain a Canvas LMS access token. If you can see a long alphanumeric token string (usually contains a ~ character), extract and return ONLY the token text, nothing else. If no token is visible, reply with exactly: NO_TOKEN',
          },
        ],
      }],
    });
    const result = response.content[0].text.trim();
    return result === 'NO_TOKEN' ? null : result;
  } catch {
    return null;
  }
}

function splitResponse(text) {
  const parts = text.split(/\n---\n/).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts : text;
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

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[b.length][a.length];
}
