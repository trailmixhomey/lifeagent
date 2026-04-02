import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { encrypt, decrypt } from './token-encryption.js';
import { normalizeE164 } from 'openclaw';

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

// --- Custom Deadlines ---

export async function getCustomDeadlines(phone) {
  return (
    (await readJson(join(studentDir(phone), 'custom-deadlines.json'))) || {
      deadlines: [],
    }
  );
}

export async function saveCustomDeadlines(phone, data) {
  const dir = studentDir(phone);
  await ensureDir(dir);
  await writeJson(join(dir, 'custom-deadlines.json'), data);
}

// --- Long-term Memory (OpenClaw workspace format) ---
// Layout: data/students/{phone}/memory/
//   MEMORY.md         — curated long-term facts (compact, used in system prompt)
//   YYYY-MM-DD.md     — daily append-only logs

function memoryDir(phone) {
  return join(studentDir(phone), 'memory');
}

export async function getCuratedMemory(phone) {
  try {
    return await readFile(join(memoryDir(phone), 'MEMORY.md'), 'utf8');
  } catch {
    return '';
  }
}

export async function saveCuratedMemory(phone, content) {
  const dir = memoryDir(phone);
  await ensureDir(dir);
  await writeFile(join(dir, 'MEMORY.md'), content, 'utf8');
}

export async function getRecentMemory(phone, days = 7) {
  const dir = memoryDir(phone);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return '';
  }
  // Match daily files (YYYY-MM-DD.md), sort descending
  const dailyFiles = files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse()
    .slice(0, days);

  const parts = [];
  for (const f of dailyFiles) {
    try {
      const text = await readFile(join(dir, f), 'utf8');
      if (text.trim()) parts.push(text.trim());
    } catch {
      // skip unreadable files
    }
  }
  return parts.join('\n\n');
}

export async function getMemory(phone) {
  const curated = await getCuratedMemory(phone);
  const recent = await getRecentMemory(phone, 7);
  if (!curated && !recent) return '';
  return [curated, recent].filter(Boolean).join('\n\n');
}

export async function appendMemory(phone, content) {
  const dir = memoryDir(phone);
  await ensureDir(dir);
  const today = new Date().toISOString().split('T')[0];
  const filePath = join(dir, `${today}.md`);
  const entry = `${content}\n`;
  try {
    const existing = await readFile(filePath, 'utf8');
    await writeFile(filePath, existing + '\n' + entry, 'utf8');
  } catch {
    await writeFile(filePath, `## ${today}\n${entry}`, 'utf8');
  }
}

export async function listDailyMemoryFiles(phone) {
  const dir = memoryDir(phone);
  try {
    const files = await readdir(dir);
    return files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

// --- Commitment Tracking ---

export async function getCommitments(phone) {
  const curated = await getCuratedMemory(phone);
  if (!curated) return [];

  const commitments = [];
  const lines = curated.split('\n');
  for (const line of lines) {
    const match = line.match(/^- \[([ x!])\] (.+?)(?:\s*\(committed (\d{4}-\d{2}-\d{2})(?:, due (\d{4}-\d{2}-\d{2}))?\))?$/);
    if (match) {
      commitments.push({
        status: match[1] === 'x' ? 'completed' : match[1] === '!' ? 'overdue' : 'pending',
        text: match[2].trim(),
        committed: match[3] || null,
        due: match[4] || null,
      });
    }
  }
  return commitments;
}

export async function updateCommitments(phone, commitments) {
  const curated = await getCuratedMemory(phone);
  if (!curated) {
    if (commitments.length === 0) return;
    const section = formatCommitmentsSection(commitments);
    await saveCuratedMemory(phone, section);
    return;
  }

  // Remove existing commitments section and replace
  const lines = curated.split('\n');
  const filtered = [];
  let inCommitments = false;
  for (const line of lines) {
    if (line.trim() === '## Active Commitments') {
      inCommitments = true;
      continue;
    }
    if (inCommitments && line.startsWith('## ')) {
      inCommitments = false;
    }
    if (inCommitments && /^- \[[ x!]\]/.test(line)) continue;
    if (inCommitments && line.trim() === '') continue;
    if (!inCommitments) filtered.push(line);
  }

  const base = filtered.join('\n').trimEnd();
  const section = formatCommitmentsSection(commitments);
  await saveCuratedMemory(phone, section ? `${base}\n\n${section}` : base);
}

function formatCommitmentsSection(commitments) {
  const active = commitments.filter((c) => c.status !== 'completed');
  if (active.length === 0) return '';

  const lines = ['## Active Commitments'];
  for (const c of active) {
    const mark = c.status === 'overdue' ? '!' : ' ';
    let entry = `- [${mark}] ${c.text}`;
    if (c.committed) {
      entry += ` (committed ${c.committed}`;
      if (c.due) entry += `, due ${c.due}`;
      entry += ')';
    }
    lines.push(entry);
  }
  return lines.join('\n');
}

// --- Conversation History ---

export async function getConversation(phone) {
  return (
    (await readJson(join(studentDir(phone), 'conversation.json'))) || {
      messages: [],
      updated_at: null,
    }
  );
}

export async function saveConversation(phone, conversation) {
  const dir = studentDir(phone);
  await ensureDir(dir);
  await writeJson(join(dir, 'conversation.json'), conversation);
}

// --- Session Keys (OpenClaw) ---

export function sessionKeyForPhone(phone) {
  return `whatsapp:dm:${normalizeE164(phone)}`;
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
  try {
    const dirs = await readdir(DATA_DIR);
    return dirs.filter((d) => d.match(/^\d+$/)).map((d) => `+${d}`);
  } catch {
    return [];
  }
}
