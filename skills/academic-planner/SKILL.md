---
name: academic-planner
description: >
  Helps students plan their study time. Looks at upcoming deadlines, checks
  their calendar for free time, estimates how long things will take, and
  suggests or creates study blocks. Triggered when a student asks to plan
  their time, wants help scheduling, or asks when to start something.
metadata:
  openclaw:
    emoji: "🗓️"
---

# Academic Planner

## Purpose
Help students figure out when to work on things and optionally put
study time on their calendar.

## When to Use
- "Help me plan my week"
- "When should I start my essay?"
- "I have 3 things due, what do I do first?"
- "Can you add study time to my calendar?"
- "What should I work on today?"
- Sunday evening weekly preview (scheduled)
- Any question about prioritization or time management

## Workflow

### When a student asks for a plan:
1. Pull current assignments from academic state (refresh if stale)
2. Filter to unsubmitted assignments due in the next 14 days
3. If Google Calendar is connected: pull events for the same period,
   identify free time blocks
4. If Google Calendar is NOT connected: build a plan based on deadlines
   alone, without specific time slots
5. Estimate effort for each assignment (see estimation rules below)
6. Build a proposed plan
7. Present the plan as a natural text conversation
8. If the student approves AND calendar is connected, create events

### Effort Estimation Rules

Start with these defaults. Over time, adjust based on the student's
actual patterns (tracked in effort-history.json):

  Essay / paper: 4-6 hours
  Problem set (math/science): 2-3 hours
  Problem set (econ/social science): 1.5-2.5 hours
  Quiz prep: 1-2 hours
  Reading assignment: 1 hour per 30 pages
  Discussion post: 30-45 minutes
  Lab report: 2-3 hours
  Group project work session: 2-3 hours
  Exam studying: 1 hour per week of material covered
  Presentation prep: 2-3 hours

When uncertain, round UP — better to overestimate and finish early
than underestimate and panic.

If the student has completed similar assignments before and we
tracked how long it took, use their personal average instead.

### Finding Available Time (requires Google Calendar)
- Check Google Calendar for existing events
- Default wake hours: 8am-11pm (configurable)
- Preferred study sessions: 1.5-2 hours
- Avoid scheduling during mealtimes (12-1pm, 6-7pm) unless asked
- Don't schedule study after 9pm unless deadline is <24 hours away
- Leave 30-minute gaps between sessions and other events
- Respect weekends — don't fill them unless deadlines demand it

### Creating Calendar Events
When the student says to go ahead:
- Event title: "Study: [Assignment Name]"
- Event description: "[Course Name] — [Assignment Name], due [date].
  Created by StudyClaw."
- Color: lavender (colorId "1") to stand out from their other events
- Set a 10-minute reminder

### How to Present Plans

BAD (too structured, feels like software):
"📋 WEEKLY STUDY PLAN
1. ECON 101 — Problem Set 3
   Estimated time: 2.5 hours
   Suggested block: Tuesday 2:00 PM - 4:30 PM
   Status: Not started"

GOOD (feels like a friend texting):
"Okay here's what I'm thinking for this week:

Tuesday afternoon (2-4:30pm) — knock out the econ problem set.
You're free then and it's due Wednesday night.

Wednesday morning (10am-12pm) — start the english essay. Then
finish it Thursday after lunch (1-3pm).

Thursday late afternoon (4-5:30pm) — CS lab, it's pretty short.

Want me to put these on your calendar?"

WITHOUT CALENDAR:
"Here's my take on your week:

Start with the econ problem set — it's due Wednesday night and
should take about 2-3 hours.

Then the english essay — give yourself two sessions, maybe
4 hours total. Aim to have it done by Thursday so you're not
rushing Friday.

CS lab is the lightest — about 90 minutes. Save it for Thursday
or Friday.

If you connect your Google Calendar I can find specific time
slots and add them for you."

## Rules
- Never present time in 24-hour format. Always "2pm" not "14:00"
- Never say "block" or "time block" — say "study time" or just
  describe when to work on something
- If the calendar is packed, don't panic them — help them prioritize
- Always ask before adding anything to their calendar
- If a student says "I already finished that" — mark it done, skip
  it in future plans
