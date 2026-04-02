/**
 * Finds available time slots in a student's schedule for study sessions.
 */

const DEFAULT_WAKE = 8;   // 8am
const DEFAULT_SLEEP = 23;  // 11pm
const MEAL_TIMES = [
  { start: 12, end: 13 },  // lunch
  { start: 18, end: 19 },  // dinner
];
const GAP_MINUTES = 30;
const PREFERRED_SESSION_HOURS = 1.5;
const LATE_CUTOFF = 21; // Don't schedule study after 9pm normally

/**
 * Find available time slots for study sessions.
 *
 * @param {Array} events - Calendar events [{ start, end, summary }]
 * @param {object} options
 * @param {Date} options.rangeStart - Start of the search range
 * @param {Date} options.rangeEnd - End of the search range
 * @param {number} options.durationHours - How long the study session needs to be
 * @param {string} options.timezone - IANA timezone string
 * @param {number} [options.wakeHour] - Hour the student wakes up (default 8)
 * @param {number} [options.sleepHour] - Hour the student sleeps (default 23)
 * @param {boolean} [options.urgent] - If true, allow late-night slots
 * @returns {Array<{ start: Date, end: Date, label: string }>}
 */
export function findSlots(events, options) {
  const {
    rangeStart,
    rangeEnd,
    durationHours,
    timezone,
    wakeHour = DEFAULT_WAKE,
    sleepHour = DEFAULT_SLEEP,
    urgent = false,
  } = options;

  const durationMs = durationHours * 60 * 60 * 1000;
  const gapMs = GAP_MINUTES * 60 * 1000;
  const slots = [];

  // Build blocked intervals from events (with gaps on each side)
  const blocked = events
    .filter((e) => !e.allDay)
    .map((e) => ({
      start: new Date(new Date(e.start).getTime() - gapMs),
      end: new Date(new Date(e.end).getTime() + gapMs),
    }));

  // Add meal times as blocked
  const current = new Date(rangeStart);
  while (current < rangeEnd) {
    for (const meal of MEAL_TIMES) {
      const mealStart = setHourInTimezone(current, meal.start, timezone);
      const mealEnd = setHourInTimezone(current, meal.end, timezone);
      blocked.push({ start: mealStart, end: mealEnd });
    }
    current.setDate(current.getDate() + 1);
  }

  // Sort blocked by start time
  blocked.sort((a, b) => a.start - b.start);

  // Scan each day in the range
  const day = new Date(rangeStart);
  while (day < rangeEnd) {
    const dayStart = setHourInTimezone(day, wakeHour, timezone);
    const lateCutoff = urgent
      ? setHourInTimezone(day, sleepHour, timezone)
      : setHourInTimezone(day, LATE_CUTOFF, timezone);

    // Only look at today or future
    if (lateCutoff <= new Date()) {
      day.setDate(day.getDate() + 1);
      continue;
    }

    const effectiveStart = new Date(Math.max(dayStart.getTime(), Date.now()));

    // Find free intervals in this day
    const freeIntervals = subtractBlocked(
      effectiveStart,
      lateCutoff,
      blocked
    );

    for (const interval of freeIntervals) {
      const available = interval.end - interval.start;
      if (available >= durationMs) {
        const slotEnd = new Date(interval.start.getTime() + durationMs);
        slots.push({
          start: interval.start,
          end: slotEnd,
          label: formatSlotLabel(interval.start, slotEnd, timezone),
        });
      }
    }

    day.setDate(day.getDate() + 1);
  }

  return slots;
}

/**
 * Subtract blocked intervals from a time range, returning free intervals.
 */
function subtractBlocked(start, end, blocked) {
  const free = [];
  let cursor = start;

  for (const b of blocked) {
    if (b.end <= cursor) continue;
    if (b.start >= end) break;

    if (b.start > cursor) {
      free.push({ start: new Date(cursor), end: new Date(Math.min(b.start, end)) });
    }
    cursor = new Date(Math.max(cursor.getTime(), b.end.getTime()));
  }

  if (cursor < end) {
    free.push({ start: new Date(cursor), end: new Date(end) });
  }

  return free;
}

/**
 * Set a specific hour on a date in a given timezone.
 */
function setHourInTimezone(date, hour, timezone) {
  const dateStr = date.toLocaleDateString('en-CA', { timeZone: timezone });
  const [year, month, day] = dateStr.split('-').map(Number);
  // Create a date string in the target timezone
  const target = new Date(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00`
  );
  // Adjust for timezone offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  });
  const localHour = parseInt(formatter.format(target));
  const diff = hour - localHour;
  target.setHours(target.getHours() + diff);
  return target;
}

/**
 * Format a slot into a human-friendly label like "Tuesday afternoon (2-4:30pm)"
 */
function formatSlotLabel(start, end, timezone) {
  const dayName = start.toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: timezone,
  });
  const startHour = parseInt(
    start.toLocaleTimeString('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    })
  );
  const timeOfDay =
    startHour < 12 ? 'morning' : startHour < 17 ? 'afternoon' : 'evening';

  const fmt = (d) =>
    d
      .toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: timezone,
      })
      .toLowerCase()
      .replace(':00', '');

  return `${dayName} ${timeOfDay} (${fmt(start)}-${fmt(end)})`;
}

/**
 * Pick the best N slots from available options, preferring:
 * 1. Weekdays over weekends
 * 2. Afternoon slots (most students' productive time)
 * 3. Spread across different days (avoid cramming)
 * 4. Earlier dates over later ones
 */
export function rankSlots(slots, n = 3) {
  return slots
    .sort((a, b) => {
      const dayA = a.start.getDay();
      const dayB = b.start.getDay();
      const weekendA = dayA === 0 || dayA === 6 ? 1 : 0;
      const weekendB = dayB === 0 || dayB === 6 ? 1 : 0;

      // Prefer weekdays
      if (weekendA !== weekendB) return weekendA - weekendB;

      // Prefer afternoon (1-5pm) over morning or evening
      const hourA = a.start.getHours();
      const hourB = b.start.getHours();
      const afternoonA = hourA >= 13 && hourA < 17 ? 0 : 1;
      const afternoonB = hourB >= 13 && hourB < 17 ? 0 : 1;
      if (afternoonA !== afternoonB) return afternoonA - afternoonB;

      // Then by date
      return a.start - b.start;
    })
    .slice(0, n);
}

/**
 * Build a study plan that spreads work across days with deadline awareness.
 *
 * @param {Array} prioritizedAssignments - From prioritizeAssignments()
 * @param {Array} events - Calendar events
 * @param {object} options - timezone, wakeHour, sleepHour
 * @returns {Array<{ assignment, slot, effort }>} Scheduled study sessions
 */
export function buildStudyPlan(prioritizedAssignments, events, options) {
  const { timezone, wakeHour = 8, sleepHour = 23 } = options;
  const plan = [];
  const usedSlots = [...events]; // track what we've scheduled to avoid double-booking

  for (const item of prioritizedAssignments) {
    const { assignment, effort, priority } = item;
    const dueDate = new Date(assignment.due_at);

    // Skip assignments more than 7 days out — students won't start that early
    if (priority.daysUntilDue > 7) continue;

    // Target scheduling window: idealStartDaysBefore to 1 day before due
    const idealStart = new Date(dueDate);
    idealStart.setDate(idealStart.getDate() - Math.min(priority.idealStartDaysBefore, 7));
    const latestStart = new Date(dueDate);
    latestStart.setDate(latestStart.getDate() - 1);

    // Don't schedule in the past
    const rangeStart = new Date(Math.max(idealStart.getTime(), Date.now()));
    const rangeEnd = new Date(Math.max(latestStart.getTime(), rangeStart.getTime() + 24 * 60 * 60 * 1000));

    const slots = findSlots(usedSlots, {
      rangeStart,
      rangeEnd,
      durationHours: Math.min(effort.hours, 2.5), // cap single session
      timezone,
      wakeHour,
      sleepHour,
      urgent: priority.daysUntilDue < 2,
    });

    const ranked = rankSlots(slots, 1);
    if (ranked.length > 0) {
      const slot = ranked[0];
      plan.push({ assignment, slot, effort });

      // Block this slot for future assignments
      usedSlots.push({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
        summary: `Study: ${assignment.name}`,
        allDay: false,
      });
    }
  }

  return plan;
}
