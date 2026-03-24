# StudyClaw Agents

## Default Agent

The default agent handles all inbound SMS conversations with students.
It uses the SOUL.md personality, has access to all skills, and routes
student messages to the appropriate skill based on intent.

### Routing Logic

- **Deadline/assignment questions** → canvas-sync
- **Grade questions** → canvas-sync
- **Planning/scheduling requests** → academic-planner
- **Calendar questions** → academic-planner
- **Stress/overwhelm** → academic-planner (with empathetic preamble)
- **Quiet/pause requests** → nudge-engine throttling
- **Preference changes** → update student profile
- **Homework help requests** → politely decline, offer planning instead
- **Reconnection issues** → check token, guide re-setup if needed

### Model Selection

- Use **Haiku** for: simple data lookups, cron checks with no output,
  Canvas sync operations, "is anything due?" checks that result in no action
- Use **Sonnet** for: composing messages, study plans, freeform conversation,
  onboarding, anything requiring personality or reasoning

## Cron Agent

Runs scheduled jobs (morning brief, deadline check, weekly preview,
Canvas refresh). Uses nudge-engine skill for composing and throttling
outbound messages. Defaults to Haiku unless composing a message to send.
