/**
 * Natural language intent classifier for student messages.
 * Routes messages to the appropriate skill and determines model tier.
 */

/**
 * Classify a student message into an intent category.
 * @param {string} message
 * @returns {'quiet'|'canvas-sync'|'academic-planner'|'stress'|'out-of-scope'|'reconnect'|'general'}
 */
export function classifyIntent(message) {
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

/**
 * Map an intent to a model tier.
 * @param {string} intent - From classifyIntent()
 * @param {boolean} isSetupComplete
 * @returns {'haiku' | 'sonnet'}
 */
export function getModelTier(intent, isSetupComplete) {
  if (!isSetupComplete) return 'sonnet';

  // Simple data lookups → haiku (cheaper, faster)
  if (intent === 'canvas-sync') return 'haiku';

  // Everything else needs personality and reasoning → sonnet
  return 'sonnet';
}
