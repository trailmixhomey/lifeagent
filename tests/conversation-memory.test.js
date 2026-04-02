import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data', 'students');
const TEST_PHONE = '+15553334444';
const TEST_DIR = join(DATA_DIR, '15553334444');
const TEST_MEMORY_DIR = join(TEST_DIR, 'memory');

process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);

describe('Conversation Memory', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('should initialize empty conversation', async () => {
    const { getConversation } = await import('../lib/student-store.js');
    const convo = await getConversation(TEST_PHONE);
    assert.deepEqual(convo.messages, []);
    assert.equal(convo.updated_at, null);
  });

  it('should save and retrieve conversation messages', async () => {
    const { getConversation, saveConversation } = await import('../lib/student-store.js');

    const convo = {
      messages: [
        { role: 'user', content: "what's due this week" },
        { role: 'assistant', content: 'You have 3 things due...' },
      ],
      updated_at: new Date().toISOString(),
    };

    await saveConversation(TEST_PHONE, convo);
    const retrieved = await getConversation(TEST_PHONE);
    assert.equal(retrieved.messages.length, 2);
    assert.equal(retrieved.messages[0].role, 'user');
    assert.equal(retrieved.messages[1].role, 'assistant');
    assert.equal(retrieved.messages[0].content, "what's due this week");
  });

  it('should preserve message roles correctly across save/load', async () => {
    const { getConversation, saveConversation } = await import('../lib/student-store.js');

    const convo = {
      messages: [
        { role: 'user', content: 'plan my week' },
        { role: 'assistant', content: 'Here is your plan...' },
        { role: 'user', content: 'yeah do it' },
        { role: 'assistant', content: 'Added to your calendar!' },
      ],
      updated_at: new Date().toISOString(),
    };

    await saveConversation(TEST_PHONE, convo);
    const retrieved = await getConversation(TEST_PHONE);

    assert.equal(retrieved.messages.length, 4);
    assert.deepEqual(
      retrieved.messages.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant']
    );
  });

  it('should cap conversation at 20 messages when trimmed', async () => {
    const { getConversation, saveConversation } = await import('../lib/student-store.js');

    const messages = [];
    for (let i = 0; i < 30; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      });
    }

    // Simulate the trimming logic from sms-handler.js
    const MAX = 20;
    const trimmed = messages.slice(-MAX);

    await saveConversation(TEST_PHONE, {
      messages: trimmed,
      updated_at: new Date().toISOString(),
    });

    const retrieved = await getConversation(TEST_PHONE);
    assert.equal(retrieved.messages.length, 20);
    assert.equal(retrieved.messages[0].content, 'Message 10');
    assert.equal(retrieved.messages[19].content, 'Message 29');
  });

  it('should store updated_at timestamp', async () => {
    const { getConversation, saveConversation } = await import('../lib/student-store.js');

    const now = new Date().toISOString();
    await saveConversation(TEST_PHONE, {
      messages: [{ role: 'user', content: 'hi' }],
      updated_at: now,
    });

    const retrieved = await getConversation(TEST_PHONE);
    assert.equal(retrieved.updated_at, now);
  });
});

describe('Memory System (OpenClaw workspace format)', () => {
  beforeEach(async () => {
    await mkdir(TEST_MEMORY_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('should return empty string when no memory exists', async () => {
    const { getCuratedMemory } = await import('../lib/student-store.js');
    const result = await getCuratedMemory(TEST_PHONE);
    assert.equal(result, '');
  });

  it('should save and retrieve curated memory', async () => {
    const { getCuratedMemory, saveCuratedMemory } = await import('../lib/student-store.js');

    await saveCuratedMemory(TEST_PHONE, '- Prefers 2-hour study blocks\n- Sophomore, CS major');
    const result = await getCuratedMemory(TEST_PHONE);
    assert.ok(result.includes('Prefers 2-hour study blocks'));
    assert.ok(result.includes('Sophomore, CS major'));
  });

  it('should append memory to daily files', async () => {
    const { appendMemory } = await import('../lib/student-store.js');

    await appendMemory(TEST_PHONE, '- Has exam next Tuesday');
    const today = new Date().toISOString().split('T')[0];
    const content = await readFile(join(TEST_MEMORY_DIR, `${today}.md`), 'utf8');
    assert.ok(content.includes('Has exam next Tuesday'));
    assert.ok(content.includes(`## ${today}`));
  });

  it('should append multiple entries to same daily file', async () => {
    const { appendMemory } = await import('../lib/student-store.js');

    await appendMemory(TEST_PHONE, '- First fact');
    await appendMemory(TEST_PHONE, '- Second fact');
    const today = new Date().toISOString().split('T')[0];
    const content = await readFile(join(TEST_MEMORY_DIR, `${today}.md`), 'utf8');
    assert.ok(content.includes('First fact'));
    assert.ok(content.includes('Second fact'));
  });

  it('should get recent memory from daily files', async () => {
    const { getRecentMemory } = await import('../lib/student-store.js');
    const { writeFile } = await import('node:fs/promises');

    // Create fake daily files
    await writeFile(join(TEST_MEMORY_DIR, '2026-03-29.md'), '## 2026-03-29\n- Fact from March 29\n');
    await writeFile(join(TEST_MEMORY_DIR, '2026-03-30.md'), '## 2026-03-30\n- Fact from March 30\n');
    await writeFile(join(TEST_MEMORY_DIR, '2026-03-31.md'), '## 2026-03-31\n- Fact from March 31\n');

    const recent = await getRecentMemory(TEST_PHONE, 2);
    assert.ok(recent.includes('March 31'));
    assert.ok(recent.includes('March 30'));
    assert.ok(!recent.includes('March 29')); // only 2 days requested
  });

  it('should combine curated + recent in getMemory', async () => {
    const { getMemory, saveCuratedMemory, appendMemory } = await import('../lib/student-store.js');

    await saveCuratedMemory(TEST_PHONE, '- Curated fact');
    await appendMemory(TEST_PHONE, '- Daily fact');

    const all = await getMemory(TEST_PHONE);
    assert.ok(all.includes('Curated fact'));
    assert.ok(all.includes('Daily fact'));
  });

  it('should list daily memory files in reverse chronological order', async () => {
    const { listDailyMemoryFiles } = await import('../lib/student-store.js');
    const { writeFile } = await import('node:fs/promises');

    await writeFile(join(TEST_MEMORY_DIR, '2026-03-28.md'), 'test');
    await writeFile(join(TEST_MEMORY_DIR, '2026-03-30.md'), 'test');
    await writeFile(join(TEST_MEMORY_DIR, '2026-03-29.md'), 'test');
    await writeFile(join(TEST_MEMORY_DIR, 'MEMORY.md'), 'test'); // should be excluded

    const files = await listDailyMemoryFiles(TEST_PHONE);
    assert.deepEqual(files, ['2026-03-30.md', '2026-03-29.md', '2026-03-28.md']);
  });
});

describe('Commitment Tracking', () => {
  beforeEach(async () => {
    await mkdir(TEST_MEMORY_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('should parse commitments from curated memory', async () => {
    const { getCommitments, saveCuratedMemory } = await import('../lib/student-store.js');

    await saveCuratedMemory(TEST_PHONE, `- Prefers morning study sessions
- [ ] Start econ essay (committed 2026-04-01, due 2026-04-05)
- [x] Submit lab report (committed 2026-03-28)
- [!] Review chapter 5 (committed 2026-03-30)`);

    const commitments = await getCommitments(TEST_PHONE);
    assert.equal(commitments.length, 3);
    assert.equal(commitments[0].status, 'pending');
    assert.equal(commitments[0].text, 'Start econ essay');
    assert.equal(commitments[0].due, '2026-04-05');
    assert.equal(commitments[1].status, 'completed');
    assert.equal(commitments[2].status, 'overdue');
  });

  it('should update commitments in curated memory', async () => {
    const { updateCommitments, getCuratedMemory, saveCuratedMemory } = await import('../lib/student-store.js');

    await saveCuratedMemory(TEST_PHONE, '- Prefers 2-hour study blocks');
    await updateCommitments(TEST_PHONE, [
      { status: 'pending', text: 'Start essay', committed: '2026-04-01', due: '2026-04-05' },
    ]);

    const result = await getCuratedMemory(TEST_PHONE);
    assert.ok(result.includes('Prefers 2-hour study blocks'));
    assert.ok(result.includes('## Active Commitments'));
    assert.ok(result.includes('[ ] Start essay'));
  });

  it('should not include completed commitments in active section', async () => {
    const { updateCommitments, getCuratedMemory } = await import('../lib/student-store.js');

    await updateCommitments(TEST_PHONE, [
      { status: 'completed', text: 'Done task', committed: '2026-04-01', due: null },
      { status: 'pending', text: 'Active task', committed: '2026-04-01', due: null },
    ]);

    const result = await getCuratedMemory(TEST_PHONE);
    assert.ok(result.includes('Active task'));
    assert.ok(!result.includes('Done task'));
  });

  it('should return session key for phone', async () => {
    const { sessionKeyForPhone } = await import('../lib/student-store.js');
    const key = sessionKeyForPhone('+15553334444');
    assert.ok(key.startsWith('whatsapp:dm:'));
    assert.ok(key.includes('15553334444'));
  });
});
