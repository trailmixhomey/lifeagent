import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data', 'students');
const TEST_PHONE = '+15559876543';
const TEST_DIR = join(DATA_DIR, '15559876543');

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

describe('Nudge Throttling', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('should initialize empty nudge log', async () => {
    const { getNudgeLog } = await import('../lib/student-store.js');
    const log = await getNudgeLog(TEST_PHONE);
    assert.deepEqual(log.nudges, []);
    assert.equal(log.quiet_until, null);
    assert.equal(log.reduced_frequency, false);
  });

  it('should save and retrieve nudge log', async () => {
    const { getNudgeLog, saveNudgeLog } = await import('../lib/student-store.js');

    const log = {
      nudges: [
        {
          sent_at: '2026-10-10T08:00:00Z',
          type: 'morning_brief',
          content_hash: 'abc123',
          responded: false,
        },
      ],
      quiet_until: null,
      reduced_frequency: false,
    };

    await saveNudgeLog(TEST_PHONE, log);
    const retrieved = await getNudgeLog(TEST_PHONE);
    assert.equal(retrieved.nudges.length, 1);
    assert.equal(retrieved.nudges[0].type, 'morning_brief');
  });

  it('should support quiet mode with expiration', async () => {
    const { getNudgeLog, saveNudgeLog } = await import('../lib/student-store.js');

    const quietUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await saveNudgeLog(TEST_PHONE, {
      nudges: [],
      quiet_until: quietUntil,
      reduced_frequency: false,
    });

    const log = await getNudgeLog(TEST_PHONE);
    assert.ok(new Date(log.quiet_until) > new Date());
  });

  it('should track responded status', async () => {
    const { getNudgeLog, saveNudgeLog } = await import('../lib/student-store.js');

    const log = {
      nudges: [
        { sent_at: new Date().toISOString(), type: 'morning_brief', content_hash: 'a', responded: false },
        { sent_at: new Date().toISOString(), type: 'deadline_warning', content_hash: 'b', responded: false },
        { sent_at: new Date().toISOString(), type: 'deadline_warning', content_hash: 'c', responded: false },
      ],
      quiet_until: null,
      reduced_frequency: false,
    };

    await saveNudgeLog(TEST_PHONE, log);
    const retrieved = await getNudgeLog(TEST_PHONE);

    // All three unreplied → should trigger reduced frequency
    const unreplied = retrieved.nudges.filter((n) => !n.responded);
    assert.equal(unreplied.length, 3);
  });

  it('should count daily nudges correctly', async () => {
    const { saveNudgeLog, getNudgeLog } = await import('../lib/student-store.js');

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const log = {
      nudges: [
        { sent_at: new Date(todayStart.getTime() + 8 * 3600000).toISOString(), type: 'morning_brief', content_hash: '1', responded: false },
        { sent_at: new Date(todayStart.getTime() + 14 * 3600000).toISOString(), type: 'deadline_warning', content_hash: '2', responded: false },
        { sent_at: new Date(todayStart.getTime() + 18 * 3600000).toISOString(), type: 'deadline_warning', content_hash: '3', responded: false },
      ],
      quiet_until: null,
      reduced_frequency: false,
    };

    await saveNudgeLog(TEST_PHONE, log);
    const retrieved = await getNudgeLog(TEST_PHONE);

    const todayNudges = retrieved.nudges.filter(
      (n) => new Date(n.sent_at) >= todayStart
    );
    assert.equal(todayNudges.length, 3, 'Should count 3 nudges today');
  });
});
