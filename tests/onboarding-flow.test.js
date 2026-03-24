import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data', 'students');
const TEST_PHONE = '+15551234567';
const TEST_DIR = join(DATA_DIR, '15551234567');

// Mock environment
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.WEB_BASE_URL = 'https://studyclaw.com';

describe('Onboarding Flow', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('should create initial profile with name step', async () => {
    const { saveProfile, getProfile } = await import('../lib/student-store.js');

    await saveProfile(TEST_PHONE, {
      phone: TEST_PHONE,
      onboarding_step: 'name',
    });

    const profile = await getProfile(TEST_PHONE);
    assert.equal(profile.phone, TEST_PHONE);
    assert.equal(profile.onboarding_step, 'name');
  });

  it('should store and encrypt canvas tokens', async () => {
    const { saveCanvasToken, getCanvasToken } = await import('../lib/student-store.js');

    const token = '7492~kJHfsdkjh3298fsdjkSDFkj23abc';
    await saveCanvasToken(TEST_PHONE, token);
    const retrieved = await getCanvasToken(TEST_PHONE);
    assert.equal(retrieved, token);
  });

  it('should store profile with all onboarding fields', async () => {
    const { saveProfile, getProfile } = await import('../lib/student-store.js');

    const profile = {
      phone: TEST_PHONE,
      name: 'Sarah',
      school: 'UC Berkeley',
      canvas_url: 'https://bcourses.berkeley.edu',
      timezone: 'America/Los_Angeles',
      setup_complete: true,
      calendar_connected: false,
      onboarding_step: 'complete',
      preferences: {
        wake_time: '08:00',
        sleep_time: '23:00',
        morning_brief: true,
        deadline_nudges: true,
        grade_notifications: true,
        weekly_preview: true,
      },
    };

    await saveProfile(TEST_PHONE, profile);
    const retrieved = await getProfile(TEST_PHONE);
    assert.equal(retrieved.name, 'Sarah');
    assert.equal(retrieved.school, 'UC Berkeley');
    assert.equal(retrieved.setup_complete, true);
    assert.equal(retrieved.preferences.morning_brief, true);
  });

  it('should update profile without overwriting existing fields', async () => {
    const { saveProfile, updateProfile, getProfile } = await import('../lib/student-store.js');

    await saveProfile(TEST_PHONE, {
      phone: TEST_PHONE,
      name: 'Sarah',
      onboarding_step: 'school',
    });

    await updateProfile(TEST_PHONE, {
      school: 'UC Berkeley',
      onboarding_step: 'token',
    });

    const profile = await getProfile(TEST_PHONE);
    assert.equal(profile.name, 'Sarah');
    assert.equal(profile.school, 'UC Berkeley');
    assert.equal(profile.onboarding_step, 'token');
  });

  it('should detect onboarded status correctly', async () => {
    const { saveProfile, isOnboarded } = await import('../lib/student-store.js');

    await saveProfile(TEST_PHONE, {
      phone: TEST_PHONE,
      onboarding_step: 'token',
    });
    assert.equal(await isOnboarded(TEST_PHONE), false);

    await saveProfile(TEST_PHONE, {
      phone: TEST_PHONE,
      setup_complete: true,
    });
    assert.equal(await isOnboarded(TEST_PHONE), true);
  });
});

describe('School Matching', () => {
  it('should have valid Canvas URLs for all schools', async () => {
    const raw = await readFile(
      join(process.cwd(), 'config', 'schools.json'),
      'utf8'
    );
    const schools = JSON.parse(raw);

    for (const [name, data] of Object.entries(schools)) {
      assert.ok(data.canvas_url, `${name} missing canvas_url`);
      assert.ok(
        data.canvas_url.startsWith('https://'),
        `${name} canvas_url should start with https://`
      );
      assert.ok(data.nickname, `${name} missing nickname`);
      assert.ok(data.timezone, `${name} missing timezone`);
    }
  });

  it('should include major Canvas schools', async () => {
    const raw = await readFile(
      join(process.cwd(), 'config', 'schools.json'),
      'utf8'
    );
    const schools = JSON.parse(raw);
    const names = Object.keys(schools);

    assert.ok(names.includes('UC Berkeley'));
    assert.ok(names.includes('UCLA'));
    assert.ok(names.includes('Stanford'));
    assert.ok(names.includes('University of Michigan'));
  });
});
