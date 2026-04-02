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

  /** Parse a Link header and return the URL for rel="next", or null. */
  _parseLinkNext(linkHeader) {
    if (!linkHeader) return null;
    const parts = linkHeader.split(',');
    for (const part of parts) {
      const match = part.match(/<([^>]+)>;\s*rel="next"/);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Fetch all pages of a paginated Canvas endpoint.
   * @param {string} path - API path
   * @param {object} params - Query parameters
   * @param {number} maxPages - Safety limit (default 10)
   */
  async _fetchAll(path, params = {}, maxPages = 10) {
    const url = new URL(`/api/v1${path}`, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        v.forEach((val) => url.searchParams.append(`${k}[]`, val));
      } else {
        url.searchParams.set(k, v);
      }
    }

    let results = [];
    let nextUrl = url.toString();
    let page = 0;

    while (nextUrl && page < maxPages) {
      const res = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const err = new Error(`Canvas API ${res.status}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      results = results.concat(data);
      nextUrl = this._parseLinkNext(res.headers.get('link'));
      page++;
    }

    return results;
  }

  /** Validate the token by fetching the current user. Returns user object or throws. */
  async validateToken() {
    return this._fetch('/users/self');
  }

  /** Get active courses. */
  async getCourses() {
    const courses = await this._fetchAll('/courses', {
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
    const assignments = await this._fetchAll(
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

  /** Get syllabus body for a course. Returns HTML string. */
  async getSyllabus(courseId) {
    const course = await this._fetch(`/courses/${courseId}`, {
      'include': ['syllabus_body'],
    });
    return {
      syllabus_body: course.syllabus_body || '',
      name: course.name,
    };
  }

  /** Get modules and their items for a course. */
  async getModules(courseId) {
    const modules = await this._fetchAll(`/courses/${courseId}/modules`, {
      'include': ['items', 'content_details'],
      per_page: '50',
    });
    return modules.map((m) => ({
      id: m.id,
      name: m.name,
      position: m.position,
      unlock_at: m.unlock_at,
      items_count: m.items_count,
      items: (m.items || []).map((item) => ({
        title: item.title,
        type: item.type,
        due_at: item.content_details?.due_at,
        points_possible: item.content_details?.points_possible,
      })),
    }));
  }

  /** Get calendar events for courses (exams, review sessions, etc. beyond assignments). */
  async getCalendarEvents(courseIds, startDate, endDate) {
    const contextCodes = courseIds.map((id) => `course_${id}`);
    const events = await this._fetchAll('/calendar_events', {
      'context_codes': contextCodes,
      start_date: startDate.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0],
      type: 'event',
      per_page: '50',
    });
    return events.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description?.replace(/<[^>]*>/g, '').substring(0, 200) || '',
      start_at: e.start_at,
      end_at: e.end_at,
      context_name: e.context_name,
    }));
  }

  /** Get planner items — unified to-do across all courses. */
  async getPlannerItems(startDate, endDate) {
    const items = await this._fetchAll('/planner/items', {
      start_date: startDate.toISOString(),
      end_date: endDate.toISOString(),
      per_page: '50',
    });
    return items.map((item) => ({
      type: item.plannable_type, // 'assignment', 'quiz', 'discussion_topic', 'planner_note'
      title: item.plannable?.title || item.plannable?.name || 'Untitled',
      course_name: item.context_name,
      due_at: item.plannable_date,
      points: item.plannable?.points_possible,
      submitted: item.submissions?.submitted,
      graded: item.submissions?.graded,
    }));
  }

  /** Get submission with comments for an assignment. */
  async getSubmissionComments(courseId, assignmentId) {
    const userId = 'self';
    const sub = await this._fetch(
      `/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`,
      { 'include': ['submission_comments', 'rubric_assessment'] }
    );
    return {
      grade: sub.grade,
      score: sub.score,
      submitted_at: sub.submitted_at,
      comments: (sub.submission_comments || []).map((c) => ({
        author: c.author_name,
        comment: c.comment,
        created_at: c.created_at,
      })),
      rubric_assessment: sub.rubric_assessment || null,
    };
  }

  /** Get announcements across courses. */
  async getAnnouncements(courseIds) {
    const contextCodes = courseIds.map((id) => `course_${id}`);
    const now = new Date();
    const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);
    const announcements = await this._fetchAll('/announcements', {
      'context_codes': contextCodes,
      start_date: twoWeeksAgo.toISOString(),
      end_date: now.toISOString(),
      per_page: '20',
    });
    return announcements.map((a) => ({
      title: a.title,
      message: a.message?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500) || '',
      posted_at: a.posted_at,
      course_name: a.context_code, // will be like 'course_12345'
      author: a.author?.display_name,
    }));
  }

  /** Get enrollment grades for all courses. */
  async getEnrollments() {
    const enrollments = await this._fetchAll('/users/self/enrollments', {
      'include': ['total_scores', 'current_grading_period_scores'],
      per_page: '50',
    });
    // Deduplicate by course_id (students often have multiple enrollments per course for lecture + recitation)
    const seen = new Set();
    return enrollments
      .filter((e) => e.type === 'StudentEnrollment')
      .filter((e) => {
        if (seen.has(e.course_id)) return false;
        seen.add(e.course_id);
        return true;
      })
      .map((e) => ({
        course_id: e.course_id,
        course_name: e.course?.name,
        current_score: e.grades?.current_score,
        current_grade: e.grades?.current_grade,
        final_score: e.grades?.final_score,
        final_grade: e.grades?.final_grade,
      }));
  }

  /** Get discussion topics for a course. */
  async getDiscussionTopics(courseId) {
    const topics = await this._fetchAll(`/courses/${courseId}/discussion_topics`, {
      order_by: 'recent_activity',
      per_page: '20',
    });
    return topics.map((t) => ({
      id: t.id,
      title: t.title,
      due_at: t.assignment?.due_at,
      points_possible: t.assignment?.points_possible,
      discussion_type: t.discussion_type,
      posted_replies: t.discussion_subentry_count,
      require_initial_post: t.require_initial_post,
      locked: t.locked,
    }));
  }

  /** Get quizzes for a course. */
  async getQuizzes(courseId) {
    const quizzes = await this._fetchAll(`/courses/${courseId}/quizzes`, {
      per_page: '20',
    });
    return quizzes.map((q) => ({
      id: q.id,
      title: q.title,
      due_at: q.due_at,
      points_possible: q.points_possible,
      time_limit: q.time_limit, // in minutes
      allowed_attempts: q.allowed_attempts,
      question_count: q.question_count,
      quiz_type: q.quiz_type,
    }));
  }

  /** Get rubrics for a course. */
  async getRubrics(courseId) {
    const rubrics = await this._fetchAll(`/courses/${courseId}/rubrics`, {
      'include': ['associations'],
      per_page: '20',
    });
    return rubrics.map((r) => ({
      id: r.id,
      title: r.title,
      points_possible: r.points_possible,
      criteria: (r.data || []).map((c) => ({
        description: c.description,
        points: c.points,
        ratings: (c.ratings || []).map((rt) => ({
          description: rt.description,
          points: rt.points,
        })),
      })),
    }));
  }

  /** Get peer reviews for an assignment. */
  async getPeerReviews(courseId, assignmentId) {
    const reviews = await this._fetchAll(
      `/courses/${courseId}/assignments/${assignmentId}/peer_reviews`,
      { per_page: '20' }
    );
    return reviews.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      assessor_id: r.assessor_id,
      workflow_state: r.workflow_state, // 'assigned' or 'completed'
    }));
  }

  /** Get user's groups across all courses. */
  async getGroups() {
    const groups = await this._fetchAll('/users/self/groups', {
      per_page: '50',
    });
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      course_id: g.course_id,
      members_count: g.members_count,
    }));
  }

  /** Get members of a group. */
  async getGroupMembers(groupId) {
    const members = await this._fetchAll(`/groups/${groupId}/users`, {
      per_page: '50',
    });
    return members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
    }));
  }

  /** Get student analytics for a course. */
  async getStudentAnalytics(courseId) {
    const userId = 'self';
    try {
      return await this._fetch(`/courses/${courseId}/analytics/users/${userId}/activity`);
    } catch {
      return null;
    }
  }

  /** Get course files, optionally filtered. */
  async getCourseFiles(courseId, searchTerm) {
    const params = { per_page: '20', sort: 'updated_at', order: 'desc' };
    if (searchTerm) params.search_term = searchTerm;
    const files = await this._fetchAll(`/courses/${courseId}/files`, params);
    return files.map((f) => ({
      id: f.id,
      name: f.display_name || f.filename,
      size: f.size,
      content_type: f.content_type,
      updated_at: f.updated_at,
      url: f.url,
    }));
  }

  /** Get conferences (office hours, meetings) for a course. */
  async getConferences(courseId) {
    try {
      const result = await this._fetch(`/courses/${courseId}/conferences`);
      const conferences = result.conferences || result;
      return (Array.isArray(conferences) ? conferences : []).map((c) => ({
        id: c.id,
        title: c.title,
        started_at: c.started_at,
        ended_at: c.ended_at,
        url: c.url,
        conference_type: c.conference_type,
      }));
    } catch {
      return [];
    }
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
