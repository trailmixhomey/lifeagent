---
name: canvas-sync
description: >
  Connects to the student's Canvas LMS account to fetch courses, assignments,
  due dates, grades, submissions, and announcements. Triggered when a student
  asks about assignments, deadlines, grades, courses, what's due, or anything
  school-related. Also runs on a scheduled basis to keep data fresh.
metadata:
  openclaw:
    emoji: "📚"
---

# Canvas Sync

## Purpose
Keep the student's academic data current by reading from their Canvas account.

## When to Use
- Student asks about assignments, deadlines, grades, or courses
- Scheduled sync runs (every 4 hours during waking hours)
- Student just completed onboarding

## Workflow

### Responding to student questions about assignments/deadlines:
1. Read the student's academic state from their local data file
2. If last sync was more than 2 hours ago, refresh from Canvas first
3. Answer the student's question using the current data
4. Always include: course name, assignment name, and relative due date
5. If an assignment has been submitted, note that

### Scheduled sync (runs silently):
1. Call Canvas API to pull active courses
2. For each course, pull assignments due in next 21 days
3. Check submission status for each assignment
4. Pull any new grades posted
5. Compare against stored state — identify changes:
   - New assignments added
   - Due dates changed
   - Grades posted
   - Assignments newly submitted
6. Update the local academic state file
7. If a NEW assignment appeared with a due date in the next 7 days,
   send the student a brief heads-up (only during waking hours)
8. If a new GRADE was posted, send a brief notification:
   "Your ECON 101 midterm grade is posted — you got an 87. Nice work!"

### Handling errors:
- If Canvas is unreachable: use cached data silently
- If the student's token stopped working: "I'm having trouble connecting
  to your school account. You might need to create a new access key —
  want me to walk you through it?" NEVER say "token expired" or
  "authentication failed"
- If a course has no assignments: skip it silently

## Canvas API Endpoints

GET /api/v1/courses?enrollment_state=active
GET /api/v1/courses/:id/assignments?order_by=due_at&include[]=submission&bucket=upcoming
GET /api/v1/users/self/upcoming_events
GET /api/v1/courses/:id/announcements

All calls use Bearer token auth with the student's stored personal access token.

## Data Format

Store in data/students/<phone>/academic-state.json:

```json
{
  "courses": [
    { "id": 12345, "name": "ECON 101", "code": "ECON101-FA26" }
  ],
  "assignments": [
    {
      "id": 67890,
      "course_id": 12345,
      "course_name": "ECON 101",
      "name": "Problem Set 3",
      "due_at": "2026-10-15T23:59:00Z",
      "points_possible": 100,
      "submitted": false,
      "grade": null,
      "assignment_type": "problem_set"
    }
  ],
  "last_sync": "2026-10-10T08:00:00Z"
}
```

## Rules
- Never expose Canvas-specific terminology to students (no "submission
  objects," "enrollment states," or "assignment groups")
- Translate assignment types into plain English
- Always sort assignments by due date (soonest first) when presenting
  to students
- If Canvas returns more data than needed, filter to what's relevant
