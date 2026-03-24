/**
 * Estimates how long an assignment will take, using defaults and personal history.
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
