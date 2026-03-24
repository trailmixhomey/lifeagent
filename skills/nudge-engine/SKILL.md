---
name: nudge-engine
description: >
  Sends proactive text messages about upcoming deadlines and academic
  tasks. Runs on scheduled cron jobs, not in response to student messages.
  Manages its own frequency and throttling to avoid being annoying.
metadata:
  openclaw:
    emoji: "⏰"
---

# Nudge Engine

## Purpose
Proactively reach out to students so deadlines don't sneak up on them.
This skill runs on cron schedules, not in response to student messages.

## Nudge Types

### Morning Brief (daily, 8am student time)
A brief, friendly check-in about the day and week ahead.

If something is due today:
"Morning Sarah! Heads up — your CS 61A lab is due tonight at
11:59pm. You've also got the econ problem set due Wednesday.
Have a good one!"

If nothing is due today:
"Morning! Nothing due today. Your next deadline is the econ
problem set on Wednesday. Enjoy the breather 😊"

If it's a heavy day:
"Hey Sarah — busy day. You've got the essay draft due at 5pm
and the problem set due tonight. If you need help prioritizing,
just text me."

### Deadline Warning (checked every 4 hours)
For unsubmitted assignments due in less than 24 hours:

"Quick reminder — your ECON 101 problem set is due tomorrow at
11:59pm. You've got study time on your calendar at 2pm today.
You got this!"

If NO study time is scheduled:
"Hey — your econ problem set is due tomorrow night and I don't
see time set aside for it. Want me to find you a slot today?"

If calendar is NOT connected:
"Hey — your econ problem set is due tomorrow night. Make sure
you've got time set aside for it today!"

### Weekly Preview (Sunday 6pm student time)
"Hey Sarah! Here's what's coming this week:

ECON 101 — Problem Set 4, due Wednesday
ENG 45 — Final essay, due Friday
CS 61A — Project checkpoint, due Friday

Want me to help plan out your study time?"

### New Assignment Alert (triggered by canvas-sync)
Only send if the new assignment is due within 7 days:
"New assignment just posted — ECON 101 has a problem set due
next Thursday. I'll include it in your morning updates."

### Grade Notification (triggered by canvas-sync)
"Your ECON 101 midterm grade is in — you got an 87! Nice work."

For grades below 70, state it neutrally without commentary:
"Your ECON 101 midterm grade is posted — 62/100."

## Throttling Rules — CRITICAL

The #1 way this product dies is if students mute the number.

1. Maximum 3 unsolicited messages per day
2. Never send between 10pm and 8am (student timezone)
3. If a student hasn't responded to the last 3 nudges, reduce to
   morning brief only until they respond
4. If a student texts "quiet," "stop," "shh," "mute," or similar:
   - Pause ALL nudges for 24 hours
   - Reply: "Got it — I'll be quiet. Text me anytime you need me,
     and I'll start the morning check-ins again tomorrow."
5. If a student says "stop" twice: pause nudges for 1 week
6. Never repeat the same information within 12 hours
7. If an assignment has been submitted, immediately stop nudging
   about it
8. The weekly preview counts as one of the 3 daily messages

## Nudge Log

Track in data/students/<phone>/nudge-log.json:
```json
{
  "nudges": [
    {
      "sent_at": "2026-10-10T08:00:00Z",
      "type": "morning_brief",
      "content_hash": "abc123",
      "responded": false
    }
  ],
  "quiet_until": null,
  "reduced_frequency": false
}
```

## Rules
- Never sound like a notification bot. Every nudge should read like a
  text from a person.
- Vary the phrasing. Don't start every morning the same way.
- If a student seems stressed, lead with empathy, dial back nudge volume
- Weekend nudges should be lighter in tone
- NEVER nudge about submitted assignments
