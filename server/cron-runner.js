/**
 * Cron job runner for StudyClaw.
 * Manages per-student scheduled jobs: morning brief, deadline checks,
 * weekly preview, and Canvas data refresh.
 */

import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  listAllStudents,
  getProfile,
  getAcademicState,
  saveAcademicState,
  getNudgeLog,
  saveNudgeLog,
  getCanvasToken,
  hasCalendar,
  getGCalTokens,
} from '../lib/student-store.js';
import { CanvasClient } from '../lib/canvas-client.js';
import { getEvents } from '../lib/calendar-client.js';
import { sendSms } from './sms-handler.js';
import { createHash } from 'node:crypto';

const anthropic = new Anthropic();

let soulPrompt = null;

async function getSoul() {
  if (!soulPrompt) {
    soulPrompt = await readFile(join(process.cwd(), 'SOUL.md'), 'utf8');
  }
  return soulPrompt;
}

/**
 * Check if we can send a nudge to this student right now.
 */
async function canNudge(phone) {
  const profile = await getProfile(phone);
  if (!profile?.setup_complete) return false;

  const nudgeLog = await getNudgeLog(phone);
  const now = new Date();

  // Check quiet mode
  if (nudgeLog.quiet_until && new Date(nudgeLog.quiet_until) > now) {
    return false;
  }

  // Check quiet hours (10pm-8am in student timezone)
  const hour = parseInt(
    now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: profile.timezone,
    })
  );
  if (hour >= 22 || hour < 8) return false;

  // Check daily limit (max 3 unsolicited)
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayNudges = nudgeLog.nudges.filter(
    (n) =>
      new Date(n.sent_at) >= todayStart &&
      n.type !== 'quiet_request'
  ).length;
  if (todayNudges >= 3) return false;

  // Check reduced frequency (only morning brief if 3 unreplied)
  if (nudgeLog.reduced_frequency) return false;

  return true;
}

/**
 * Check if student has ignored the last 3 nudges.
 */
async function checkReducedFrequency(phone) {
  const nudgeLog = await getNudgeLog(phone);
  const recent = nudgeLog.nudges
    .filter((n) => n.type !== 'quiet_request')
    .slice(-3);

  if (recent.length >= 3 && recent.every((n) => !n.responded)) {
    nudgeLog.reduced_frequency = true;
    await saveNudgeLog(phone, nudgeLog);
    return true;
  }
  return false;
}

/**
 * Record that a nudge was sent.
 */
async function recordNudge(phone, type, content) {
  const nudgeLog = await getNudgeLog(phone);
  const hash = createHash('md5').update(content).digest('hex').slice(0, 8);

  // Check if we already sent something with this content in the last 12 hours
  const twelvHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
  const duplicate = nudgeLog.nudges.find(
    (n) =>
      n.content_hash === hash &&
      new Date(n.sent_at).getTime() > twelvHoursAgo
  );
  if (duplicate) return false;

  nudgeLog.nudges.push({
    sent_at: new Date().toISOString(),
    type,
    content_hash: hash,
    responded: false,
  });

  // Keep last 200 nudges
  if (nudgeLog.nudges.length > 200) {
    nudgeLog.nudges = nudgeLog.nudges.slice(-200);
  }

  await saveNudgeLog(phone, nudgeLog);
  return true;
}

/**
 * Morning brief: send a summary of today's and this week's deadlines.
 */
async function morningBrief(phone) {
  if (!(await canNudge(phone))) return;

  const profile = await getProfile(phone);
  const state = await getAcademicState(phone);
  const soul = await getSoul();
  const now = new Date();

  const upcoming = state.assignments
    .filter((a) => !a.submitted && new Date(a.due_at) > now)
    .slice(0, 10);

  if (upcoming.length === 0) return; // nothing to report

  let calendarContext = '';
  if (await hasCalendar(phone)) {
    try {
      const tokens = await getGCalTokens(phone);
      const dayEnd = new Date(now);
      dayEnd.setHours(23, 59, 59);
      const events = await getEvents(tokens, now, dayEnd);
      if (events.length > 0) {
        calendarContext = `\nToday's calendar:\n${events.map((e) => `- ${e.summary} at ${new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: profile.timezone })}`).join('\n')}\n`;
      }
    } catch {
      // Calendar unavailable, skip
    }
  }

  const assignmentList = upcoming
    .map((a) => {
      const due = new Date(a.due_at).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: profile.timezone,
      });
      return `- ${a.course_name}: ${a.name}, due ${due}`;
    })
    .join('\n');

  const dayOfWeek = now.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: profile.timezone,
  });

  const prompt = `Compose a morning brief text message for ${profile.name}. It's ${dayOfWeek} morning.
${calendarContext}
Upcoming assignments:
${assignmentList}

Rules:
- Keep it brief and casual (it's a text message)
- Mention what's due today first, then this week
- Vary the opening (don't always start with "Morning!")
- Max 300 characters if possible
- Don't use the word "brief" or "update"
- If it's a weekend, keep it lighter in tone`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: soul,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  const recorded = await recordNudge(phone, 'morning_brief', text);
  if (recorded) {
    await sendSms(phone, text);
  }
}

/**
 * Deadline check: warn about assignments due in the next 24 hours.
 */
async function deadlineCheck(phone) {
  if (!(await canNudge(phone))) return;
  const reduced = await checkReducedFrequency(phone);
  if (reduced) return;

  const profile = await getProfile(phone);
  const state = await getAcademicState(phone);
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const urgent = state.assignments.filter(
    (a) =>
      !a.submitted &&
      new Date(a.due_at) > now &&
      new Date(a.due_at) <= tomorrow
  );

  if (urgent.length === 0) return;

  const soul = await getSoul();

  for (const assignment of urgent) {
    const dueStr = new Date(assignment.due_at).toLocaleString('en-US', {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: profile.timezone,
    });

    const prompt = `Compose a brief deadline reminder text for ${profile.name}.
Assignment: ${assignment.course_name} — ${assignment.name}
Due: ${dueStr}
Calendar connected: ${profile.calendar_connected ? 'yes' : 'no'}

Keep it short, friendly, encouraging. Don't be preachy.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      system: soul,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;
    const recorded = await recordNudge(phone, 'deadline_warning', text);
    if (recorded) {
      await sendSms(phone, text);
    }
  }
}

/**
 * Weekly preview: Sunday evening summary of the week ahead.
 */
async function weeklyPreview(phone) {
  if (!(await canNudge(phone))) return;

  const profile = await getProfile(phone);
  const state = await getAcademicState(phone);
  const soul = await getSoul();
  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const thisWeek = state.assignments.filter(
    (a) =>
      !a.submitted &&
      new Date(a.due_at) > now &&
      new Date(a.due_at) <= nextWeek
  );

  if (thisWeek.length === 0) return;

  const list = thisWeek
    .map((a) => {
      const due = new Date(a.due_at).toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: profile.timezone,
      });
      return `- ${a.course_name} — ${a.name}, due ${due}`;
    })
    .join('\n');

  const prompt = `Compose a Sunday evening weekly preview text for ${profile.name}.
Assignments due this week:
${list}

Keep it light — it's the weekend. Offer to help plan study time.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: soul,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;
  const recorded = await recordNudge(phone, 'weekly_preview', text);
  if (recorded) {
    await sendSms(phone, text);
  }
}

/**
 * Canvas refresh: silently sync data, notify only on new assignments or grades.
 */
async function canvasRefresh(phone) {
  const profile = await getProfile(phone);
  if (!profile?.setup_complete) return;

  const token = await getCanvasToken(phone);
  if (!token) return;

  try {
    const client = new CanvasClient(profile.canvas_url, token);
    const { courses, assignments } = await client.fullSync();
    const oldState = await getAcademicState(phone);

    const oldIds = new Set(oldState.assignments.map((a) => a.id));
    const oldGrades = new Map(
      oldState.assignments
        .filter((a) => a.grade != null)
        .map((a) => [a.id, a.grade])
    );

    const newState = {
      courses,
      assignments,
      last_sync: new Date().toISOString(),
    };
    await saveAcademicState(phone, newState);

    // Check for new assignments due within 7 days
    const sevenDays = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const newAssignments = assignments.filter(
      (a) =>
        !oldIds.has(a.id) &&
        new Date(a.due_at).getTime() <= sevenDays
    );

    // Check for new grades
    const newGrades = assignments.filter(
      (a) => a.grade != null && !oldGrades.has(a.id)
    );

    if (!(await canNudge(phone))) return;

    // Notify about new assignments
    for (const a of newAssignments) {
      const dueDay = new Date(a.due_at).toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: profile.timezone,
      });
      const msg = `New assignment just posted — ${a.course_name} has ${a.name} due ${dueDay}. I'll include it in your morning updates.`;
      const recorded = await recordNudge(phone, 'new_assignment', msg);
      if (recorded) await sendSms(phone, msg);
    }

    // Notify about new grades
    for (const a of newGrades) {
      const score = a.score != null ? a.score : a.grade;
      const total = a.points_possible;
      let msg;
      if (typeof score === 'number' && score >= 70) {
        msg = `Your ${a.course_name} ${a.name} grade is in — you got ${score}${total ? `/${total}` : ''}! Nice work.`;
      } else {
        msg = `Your ${a.course_name} ${a.name} grade is posted — ${score}${total ? `/${total}` : ''}.`;
      }
      const recorded = await recordNudge(phone, 'grade_notification', msg);
      if (recorded) await sendSms(phone, msg);
    }
  } catch {
    // Silent failure — will retry on next cron run
  }
}

/**
 * Start all cron jobs.
 */
export function startCronJobs() {
  // Morning brief — 8am, but we run at the top of every hour
  // and check each student's timezone internally
  cron.schedule('0 * * * *', async () => {
    const students = await listAllStudents();
    for (const phone of students) {
      try {
        const profile = await getProfile(phone);
        if (!profile?.setup_complete) continue;

        const hour = parseInt(
          new Date().toLocaleTimeString('en-US', {
            hour: 'numeric',
            hour12: false,
            timeZone: profile.timezone,
          })
        );

        if (hour === 8) {
          await morningBrief(phone);
        }
      } catch (err) {
        console.error(`Morning brief error for ${phone}:`, err);
      }
    }
  });

  // Deadline check — every 4 hours at 10am, 2pm, 6pm student time
  cron.schedule('0 * * * *', async () => {
    const students = await listAllStudents();
    for (const phone of students) {
      try {
        const profile = await getProfile(phone);
        if (!profile?.setup_complete) continue;

        const hour = parseInt(
          new Date().toLocaleTimeString('en-US', {
            hour: 'numeric',
            hour12: false,
            timeZone: profile.timezone,
          })
        );

        if ([10, 14, 18].includes(hour)) {
          await deadlineCheck(phone);
        }
      } catch (err) {
        console.error(`Deadline check error for ${phone}:`, err);
      }
    }
  });

  // Weekly preview — Sunday at 6pm student time
  cron.schedule('0 * * * 0', async () => {
    const students = await listAllStudents();
    for (const phone of students) {
      try {
        const profile = await getProfile(phone);
        if (!profile?.setup_complete) continue;

        const hour = parseInt(
          new Date().toLocaleTimeString('en-US', {
            hour: 'numeric',
            hour12: false,
            timeZone: profile.timezone,
          })
        );

        if (hour === 18) {
          await weeklyPreview(phone);
        }
      } catch (err) {
        console.error(`Weekly preview error for ${phone}:`, err);
      }
    }
  });

  // Canvas refresh — every 4 hours at 8am, 12pm, 4pm, 8pm student time
  cron.schedule('0 * * * *', async () => {
    const students = await listAllStudents();
    for (const phone of students) {
      try {
        const profile = await getProfile(phone);
        if (!profile?.setup_complete) continue;

        const hour = parseInt(
          new Date().toLocaleTimeString('en-US', {
            hour: 'numeric',
            hour12: false,
            timeZone: profile.timezone,
          })
        );

        if ([8, 12, 16, 20].includes(hour)) {
          await canvasRefresh(phone);
        }
      } catch (err) {
        console.error(`Canvas refresh error for ${phone}:`, err);
      }
    }
  });

  console.log('Cron jobs started');
}
