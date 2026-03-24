/**
 * Canvas LMS API client.
 * Wraps the Canvas REST API for reading courses, assignments, grades, and submissions.
 */

const TIMEOUT_MS = 10_000;

export class CanvasClient {
  constructor(baseUrl, token) {
    // Normalize: strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  async _fetch(path, params = {}) {
    const url = new URL(`/api/v1${path}`, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        v.forEach((val) => url.searchParams.append(`${k}[]`, val));
      } else {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const err = new Error(`Canvas API ${res.status}`);
      err.status = res.status;
      throw err;
    }

    return res.json();
  }

  /** Validate the token by fetching the current user. Returns user object or throws. */
  async validateToken() {
    return this._fetch('/users/self');
  }

  /** Get active courses. */
  async getCourses() {
    const courses = await this._fetch('/courses', {
      enrollment_state: 'active',
      per_page: '50',
    });
    return courses.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.course_code,
    }));
  }

  /** Get upcoming assignments for a course, including submission status. */
  async getAssignments(courseId) {
    const assignments = await this._fetch(
      `/courses/${courseId}/assignments`,
      {
        order_by: 'due_at',
        'include': ['submission'],
        bucket: 'upcoming',
        per_page: '50',
      }
    );

    return assignments
      .filter((a) => a.due_at) // skip assignments with no due date
      .map((a) => ({
        id: a.id,
        course_id: courseId,
        name: a.name,
        due_at: a.due_at,
        points_possible: a.points_possible,
        submitted: a.submission?.workflow_state === 'submitted' ||
                   a.submission?.workflow_state === 'graded',
        grade: a.submission?.grade ?? null,
        score: a.submission?.score ?? null,
        assignment_type: classifyAssignment(a.name, a.submission_types),
      }));
  }

  /** Get upcoming events (assignments + calendar events). */
  async getUpcomingEvents() {
    return this._fetch('/users/self/upcoming_events');
  }

  /** Get announcements for a course. */
  async getAnnouncements(courseId) {
    const now = new Date();
    const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);
    return this._fetch(`/courses/${courseId}/announcements`, {
      start_date: twoWeeksAgo.toISOString(),
      end_date: now.toISOString(),
    });
  }

  /**
   * Full sync: fetch all courses and their upcoming assignments.
   * Returns { courses, assignments } in our normalized format.
   */
  async fullSync() {
    const courses = await this.getCourses();
    const allAssignments = [];

    for (const course of courses) {
      try {
        const assignments = await this.getAssignments(course.id);
        allAssignments.push(
          ...assignments.map((a) => ({ ...a, course_name: course.name }))
        );
      } catch {
        // If one course fails, continue with the rest
      }
    }

    // Sort by due date
    allAssignments.sort(
      (a, b) => new Date(a.due_at) - new Date(b.due_at)
    );

    return { courses, assignments: allAssignments };
  }
}

/**
 * Best-effort classification of assignment type from name and submission types.
 */
function classifyAssignment(name, submissionTypes = []) {
  const lower = name.toLowerCase();
  if (lower.includes('essay') || lower.includes('paper') || lower.includes('draft'))
    return 'essay';
  if (lower.includes('problem set') || lower.includes('pset') || lower.includes('homework'))
    return 'problem_set';
  if (lower.includes('quiz')) return 'quiz';
  if (lower.includes('exam') || lower.includes('midterm') || lower.includes('final'))
    return 'exam';
  if (lower.includes('lab')) return 'lab';
  if (lower.includes('discussion') || lower.includes('forum'))
    return 'discussion';
  if (lower.includes('reading')) return 'reading';
  if (lower.includes('presentation') || lower.includes('slides'))
    return 'presentation';
  if (lower.includes('project')) return 'project';
  if (submissionTypes.includes('discussion_topic')) return 'discussion';
  if (submissionTypes.includes('online_quiz')) return 'quiz';
  return 'assignment';
}

/**
 * Create a CanvasClient, handling common error patterns with human-friendly messages.
 */
export function createCanvasClient(canvasUrl, token) {
  return new CanvasClient(canvasUrl, token);
}

/**
 * Classify a Canvas API error into a human-friendly category.
 */
export function classifyCanvasError(err) {
  if (err.status === 401) {
    return {
      type: 'auth',
      message:
        "I'm having trouble connecting to your school account. You might need to create a new access key — want me to walk you through it?",
    };
  }
  if (err.status === 500) {
    return {
      type: 'server',
      message:
        "Your school's system is having issues right now. I'll try again in a bit.",
    };
  }
  if (err.name === 'TimeoutError' || err.code === 'ABORT_ERR') {
    return {
      type: 'timeout',
      message:
        "Canvas is being slow — I'll check back and update you.",
    };
  }
  return {
    type: 'unknown',
    message:
      "I'm having a little trouble reaching your school's system right now. I'll try again shortly.",
  };
}
