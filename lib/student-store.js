import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { encrypt, decrypt } from './token-encryption.js';

const DATA_DIR = join(process.cwd(), 'data', 'students');

function studentDir(phone) {
  return join(DATA_DIR, phone.replace('+', ''));
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function readJson(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(filePath, data) {
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// --- Profile ---

export async function getProfile(phone) {
  return readJson(join(studentDir(phone), 'profile.json'));
}

export async function saveProfile(phone, profile) {
  const dir = studentDir(phone);
  await ensureDir(dir);
  await writeJson(join(dir, 'profile.json'), profile);
}

export async function updateProfile(phone, updates) {
  const profile = (await getProfile(phone)) || {};
  Object.assign(profile, updates);
  await saveProfile(phone, profile);
  return profile;
}

// --- Canvas Token ---

export async function getCanvasToken(phone) {
  const data = await readJson(join(studentDir(phone), 'canvas-token.json'));
  if (!data) return null;
  return decrypt(data);
}

export async function saveCanvasToken(phone, token) {
  const dir = studentDir(phone);
  await ensureDir(dir);
  const encrypted = encrypt(token);
  await writeJson(join(dir, 'canvas-token.json'), encrypted);
}

// --- Google Calendar Tokens ---

export async function getGCalTokens(phone) {
  const data = await readJson(join(studentDir(phone), 'gcal-tokens.json'));
  if (!data) return null;
  const decrypted = decrypt(data.blob);
  return JSON.parse(decrypted);
}

export async function saveGCalTokens(phone, tokens) {
  const dir = studentDir(phone);
  await ensureDir(dir);
  const encrypted = encrypt(JSON.stringify(tokens));
  await writeJson(join(dir, 'gcal-tokens.json'), { blob: encrypted });
}

// --- Academic State ---

export async function getAcademicState(phone) {
  return (
    (await readJson(join(studentDir(phone), 'academic-state.json'))) || {
      courses: [],
      assignments: [],
      last_sync: null,
    }
  );
}

export async function saveAcademicState(phone, state) {
  const dir = studentDir(phone);
  await ensureDir(dir);
  await writeJson(join(dir, 'academic-state.json'), state);
}

// --- Effort History ---

export async function getEffortHistory(phone) {
  return (
    (await readJson(join(studentDir(phone), 'effort-history.json'))) || {
      entries: [],
    }
  );
}

export async function saveEffortHistory(phone, history) {
  const dir = studentDir(phone);
  await ensureDir(dir);
  await writeJson(join(dir, 'effort-history.json'), history);
}

// --- Nudge Log ---

export async function getNudgeLog(phone) {
  return (
    (await readJson(join(studentDir(phone), 'nudge-log.json'))) || {
      nudges: [],
      quiet_until: null,
      reduced_frequency: false,
    }
  );
}

export async function saveNudgeLog(phone, log) {
  const dir = studentDir(phone);
  await ensureDir(dir);
  await writeJson(join(dir, 'nudge-log.json'), log);
}

// --- Helpers ---

export async function isOnboarded(phone) {
  const profile = await getProfile(phone);
  return profile?.setup_complete === true;
}

export async function hasCalendar(phone) {
  const profile = await getProfile(phone);
  return profile?.calendar_connected === true;
}

export async function listAllStudents() {
  const { readdir } = await import('node:fs/promises');
  try {
    const dirs = await readdir(DATA_DIR);
    return dirs.filter((d) => d.match(/^\d+$/)).map((d) => `+${d}`);
  } catch {
    return [];
  }
}
