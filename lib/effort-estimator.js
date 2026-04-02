/**
 * Estimates how long an assignment will take, using defaults and personal history.
 * Also computes priority scores for scheduling order.
 */

// Default effort estimates in hours
const DEFAULTS = {
  essay: 5,
  paper: 5,
  problem_set: 2.5,
  quiz: 1.5,
  exam: 0, // handled separately based on weeks of material
  lab: 2.5,
  discussion: 0.6,
  reading: 1,
  presentation: 2.5,
  project: 3,
  assignment: 2, // fallback
};

// How demanding each type is (affects scheduling priority)
const DIFFICULTY_WEIGHT = {
  exam: 1.0,
  essay: 0.8,
  paper: 0.8,
  project: 0.7,
  problem_set: 0.6,
  lab: 0.5,
  presentation: 0.5,
  quiz: 0.4,
  reading: 0.2,
  discussion: 0.1,
  assignment: 0.4,
};

/**
 * Estimate hours needed for an assignment.
 *
 * @param {object} assignment - Assignment from academic state
 * @param {object} effortHistory - Student's effort-history.json data
 * @returns {{ hours: number, source: 'personal' | 'default', label: string }}
 */
export function estimateEffort(assignment, effortHistory = { entries: [] }) {
  const type = assignment.assignment_type || 'assignment';

  // Check personal history for this course + assignment type
  const relevant = effortHistory.entries.filter(
    (e) =>
      e.course_id === assignment.course_id &&
      e.assignment_type === type &&
      e.actual_hours != null
  );

  if (relevant.length >= 2) {
    const avg =
      relevant.reduce((sum, e) => sum + e.actual_hours, 0) / relevant.length;
    const rounded = Math.round(avg * 2) / 2; // round to nearest 0.5
    return {
      hours: rounded,
      source: 'personal',
      label: formatHours(rounded),
    };
  }

  // Fall back to defaults
  const hours = DEFAULTS[type] || DEFAULTS.assignment;
  return {
    hours,
    source: 'default',
    label: formatHours(hours),
  };
}

/**
 * Compute a priority score for an assignment.
 * Higher score = schedule sooner.
 *
 * Factors:
 * - Deadline proximity (closer = higher priority)
 * - Assignment difficulty/weight (harder = higher priority)
 * - Points possible (more points = higher priority)
 * - Effort required (longer assignments need earlier starts)
 *
 * @param {object} assignment - Assignment from academic state
 * @param {number} estimatedHours - From estimateEffort()
 * @returns {{ score: number, urgency: string, idealStartDaysBefore: number }}
 */
export function computePriority(assignment, estimatedHours) {
  const now = Date.now();
  const dueAt = new Date(assignment.due_at).getTime();
  const hoursUntilDue = Math.max(0, (dueAt - now) / (1000 * 60 * 60));
  const daysUntilDue = hoursUntilDue / 24;

  const type = assignment.assignment_type || 'assignment';
  const difficulty = DIFFICULTY_WEIGHT[type] || 0.4;

  // Points factor — normalize around 100 points
  const pointsFactor = assignment.points_possible
    ? Math.min(assignment.points_possible / 100, 2)
    : 0.5;

  // Deadline urgency — exponential increase as deadline approaches
  const deadlineUrgency = Math.max(0, 10 / (daysUntilDue + 1));

  // Effort urgency — longer assignments need more lead time
  const effortUrgency = estimatedHours / (hoursUntilDue + 1);

  const score =
    deadlineUrgency * 3 +
    difficulty * 2 +
    pointsFactor * 1.5 +
    effortUrgency * 2;

  // How many days before the deadline to ideally start
  // Cap at 7 — students won't realistically start more than a week early
  let idealStartDaysBefore;
  if (estimatedHours <= 1) idealStartDaysBefore = 1;
  else if (estimatedHours <= 3) idealStartDaysBefore = 2;
  else if (estimatedHours <= 6) idealStartDaysBefore = 3;
  else idealStartDaysBefore = Math.min(5, Math.ceil(estimatedHours / 2));
  idealStartDaysBefore = Math.min(idealStartDaysBefore, 7);

  // Urgency label
  let urgency;
  if (daysUntilDue < 1) urgency = 'due today';
  else if (daysUntilDue < 2) urgency = 'due tomorrow';
  else if (daysUntilDue < 3) urgency = 'due soon';
  else urgency = 'upcoming';

  return { score, urgency, idealStartDaysBefore, daysUntilDue };
}

/**
 * Sort assignments by priority and return a recommended work order.
 *
 * @param {Array} assignments - From academic state (unsubmitted, upcoming)
 * @param {object} effortHistory - Student's effort-history.json
 * @returns {Array<{ assignment, effort, priority }>}
 */
export function prioritizeAssignments(assignments, effortHistory = { entries: [] }) {
  return assignments
    .map((a) => {
      const effort = estimateEffort(a, effortHistory);
      const priority = computePriority(a, effort.hours);
      return { assignment: a, effort, priority };
    })
    .sort((a, b) => b.priority.score - a.priority.score);
}

/**
 * Format hours into a human-readable string.
 * 0.5 → "30 minutes", 1 → "about an hour", 2.5 → "about 2-3 hours"
 */
export function formatHours(hours) {
  if (hours <= 0.5) return '30 minutes';
  if (hours <= 0.75) return 'about 45 minutes';
  if (hours <= 1) return 'about an hour';
  if (hours <= 1.5) return 'about 90 minutes';

  const low = Math.floor(hours);
  const high = Math.ceil(hours);
  if (low === high) return `about ${low} hours`;
  return `about ${low}-${high} hours`;
}

/**
 * Record how long an assignment actually took (for future estimation).
 */
export function recordEffort(effortHistory, entry) {
  effortHistory.entries.push({
    course_id: entry.course_id,
    assignment_type: entry.assignment_type,
    assignment_name: entry.assignment_name,
    actual_hours: entry.actual_hours,
    recorded_at: new Date().toISOString(),
  });

  // Keep the last 100 entries
  if (effortHistory.entries.length > 100) {
    effortHistory.entries = effortHistory.entries.slice(-100);
  }

  return effortHistory;
}
