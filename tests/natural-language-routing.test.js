import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for natural language intent classification.
 * These verify that student messages get routed to the right skill.
 */

// Intent classifier extracted for testing
function classifyIntent(message) {
  const lower = message.toLowerCase().trim();

  // Quiet / mute requests
  const quietPatterns = ['stop', 'quiet', 'mute', 'shut up', 'shh', 'leave me alone', 'too many texts'];
  if (quietPatterns.some((p) => lower.includes(p))) return 'quiet';

  // Deadline / assignment questions → canvas-sync
  const deadlinePatterns = [
    /what('s| is| are)\s+(due|coming up)/,
    /due\s+dates?/,
    /when\s+(is|are)\s+(the|my)/,
    /anything\s+due/,
    /assignments?$/,
    /what\s+do\s+i\s+have/,
    /deadlines?/,
  ];
  if (deadlinePatterns.some((p) => p.test(lower))) return 'canvas-sync';

  // Grade questions → canvas-sync
  const gradePatterns = [
    /grades?/,
    /what\s+did\s+i\s+get/,
    /how\s+did\s+i\s+do/,
    /score/,
    /midterm\s+(results?|grades?)/,
  ];
  if (gradePatterns.some((p) => p.test(lower))) return 'canvas-sync';

  // Planning requests → academic-planner
  const planPatterns = [
    /plan\s+(my|this|the)/,
    /help\s+me\s+plan/,
    /when\s+should\s+i\s+(start|study|begin)/,
    /schedule\s+study/,
    /what\s+should\s+i\s+(work|do|focus)/,
    /what('s| is)\s+most\s+important/,
    /prioriti[sz]e/,
    /what\s+do\s+i\s+do\s+first/,
    /add\s+(study|it)\s+to\s+(my\s+)?calendar/,
    /put\s+(it|these|them)\s+on\s+(my\s+)?calendar/,
  ];
  if (planPatterns.some((p) => p.test(lower))) return 'academic-planner';

  // Calendar questions → academic-planner
  const calendarPatterns = [
    /what('s| is)\s+on\s+my\s+calendar/,
    /am\s+i\s+free/,
    /what\s+do\s+i\s+have\s+(going\s+on|today|tomorrow)/,
    /my\s+schedule/,
  ];
  if (calendarPatterns.some((p) => p.test(lower))) return 'academic-planner';

  // Stress → academic-planner (with empathy)
  const stressPatterns = [
    /so\s+much\s+to\s+do/,
    /i('m| am)\s+(stressed|overwhelmed|screwed|freaking)/,
    /i\s+can('t| not)\s+(do|handle)\s+this/,
    /too\s+much/,
  ];
  if (stressPatterns.some((p) => p.test(lower))) return 'stress';

  // Out of scope — homework help
  const homeworkPatterns = [
    /help\s+me\s+write/,
    /what('s| is)\s+the\s+answer/,
    /do\s+my\s+homework/,
    /solve\s+this/,
    /write\s+my\s+essay/,
  ];
  if (homeworkPatterns.some((p) => p.test(lower))) return 'out-of-scope';

  // Reconnection
  const reconnectPatterns = [
    /not\s+showing/,
    /something('s| is)\s+(not\s+)?working/,
    /can('t| not)\s+see\s+my\s+class/,
    /broken/,
  ];
  if (reconnectPatterns.some((p) => p.test(lower))) return 'reconnect';

  return 'general';
}

describe('Natural Language Routing', () => {
  describe('Deadline questions → canvas-sync', () => {
    const cases = [
      "what's due",
      "what do i have due",
      "anything due this week",
      "due dates",
      "what's coming up",
      "when is the essay due",
      "when's my next assignment",
      "do I have anything due tomorrow",
      "what are my deadlines",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to canvas-sync`, () => {
        assert.equal(classifyIntent(msg), 'canvas-sync');
      });
    }
  });

  describe('Grade questions → canvas-sync', () => {
    const cases = [
      "did I get my grade",
      "what did I get on the midterm",
      "grades",
      "how did I do",
      "midterm results",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to canvas-sync`, () => {
        assert.equal(classifyIntent(msg), 'canvas-sync');
      });
    }
  });

  describe('Planning requests → academic-planner', () => {
    const cases = [
      "help me plan",
      "plan my week",
      "when should I study",
      "schedule study time",
      "what should I work on",
      "what's most important",
      "what do I do first",
      "add study to my calendar",
      "put these on my calendar",
      "when should I start my essay",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to academic-planner`, () => {
        assert.equal(classifyIntent(msg), 'academic-planner');
      });
    }
  });

  describe('Stress → stress handler', () => {
    const cases = [
      "I have so much to do",
      "I'm stressed",
      "I'm overwhelmed",
      "I'm screwed",
      "I can't do this",
      "too much",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to stress handler`, () => {
        assert.equal(classifyIntent(msg), 'stress');
      });
    }
  });

  describe('Quiet requests → quiet handler', () => {
    const cases = [
      "stop",
      "quiet",
      "mute",
      "shut up",
      "shh",
      "leave me alone",
      "too many texts",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to quiet handler`, () => {
        assert.equal(classifyIntent(msg), 'quiet');
      });
    }
  });

  describe('Out of scope → polite decline', () => {
    const cases = [
      "help me write my essay",
      "what's the answer to question 3",
      "do my homework",
      "solve this problem",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to out-of-scope`, () => {
        assert.equal(classifyIntent(msg), 'out-of-scope');
      });
    }
  });

  describe('Reconnection → reconnect handler', () => {
    const cases = [
      "it's not showing my classes",
      "something's not working",
      "I can't see my classes",
    ];

    for (const msg of cases) {
      it(`should route "${msg}" to reconnect handler`, () => {
        assert.equal(classifyIntent(msg), 'reconnect');
      });
    }
  });
});
