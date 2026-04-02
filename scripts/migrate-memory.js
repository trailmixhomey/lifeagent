#!/usr/bin/env node

/**
 * One-time migration: convert monolithic memory.md files to the new
 * OpenClaw workspace format (MEMORY.md + daily files).
 *
 * For each student:
 *   1. Parse memory.md into date-stamped sections
 *   2. Write each section to memory/{YYYY-MM-DD}.md
 *   3. Generate a curated MEMORY.md via Claude
 *   4. Rename old memory.md to memory.md.bak
 *
 * Usage: node scripts/migrate-memory.js [--dry-run]
 */

import 'dotenv/config';
import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const DATA_DIR = join(process.cwd(), 'data', 'students');
const DRY_RUN = process.argv.includes('--dry-run');
const anthropic = new Anthropic();

async function listStudentDirs() {
  try {
    const dirs = await readdir(DATA_DIR);
    return dirs.filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
}

function parseSections(content) {
  const sections = [];
  const lines = content.split('\n');
  let currentDate = null;
  let currentLines = [];

  for (const line of lines) {
    const dateMatch = line.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      if (currentDate && currentLines.length > 0) {
        sections.push({ date: currentDate, content: currentLines.join('\n').trim() });
      }
      currentDate = dateMatch[1];
      currentLines = [];
    } else if (currentDate) {
      // Skip the "# Student Memory" header
      if (line.trim() !== '# Student Memory') {
        currentLines.push(line);
      }
    }
  }
  // Push final section
  if (currentDate && currentLines.length > 0) {
    sections.push({ date: currentDate, content: currentLines.join('\n').trim() });
  }
  return sections;
}

async function curate(allContent) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `These are daily memory notes about a college student. Merge them into a curated summary of durable facts.

KEEP: preferences, habits, schedule constraints, personal details (name, major, year), behavioral patterns, study preferences, recurring commitments.
DROP: one-time events that already passed, submitted assignments, ephemeral facts.

Format as bullet points. Keep it under 30 bullets. No headers, just the bullets.

---
${allContent}
---

Curated summary:`,
    }],
  });
  return response.content[0].text.trim();
}

async function migrateStudent(phoneDir) {
  const studentPath = join(DATA_DIR, phoneDir);
  const memoryPath = join(studentPath, 'memory.md');

  let content;
  try {
    content = await readFile(memoryPath, 'utf8');
  } catch {
    console.log(`  [skip] +${phoneDir}: no memory.md`);
    return;
  }

  if (!content.trim()) {
    console.log(`  [skip] +${phoneDir}: empty memory.md`);
    return;
  }

  const sections = parseSections(content);
  console.log(`  [migrate] +${phoneDir}: ${sections.length} date sections found`);

  // Group sections by date (multiple entries per day are common)
  const byDate = new Map();
  for (const s of sections) {
    const existing = byDate.get(s.date) || [];
    existing.push(s.content);
    byDate.set(s.date, existing);
  }

  if (DRY_RUN) {
    for (const [date, contents] of byDate) {
      const combined = contents.join('\n');
      console.log(`    -> memory/${date}.md (${combined.length} chars, ${contents.length} section(s))`);
    }
    return;
  }

  // Create memory/ directory
  const memDir = join(studentPath, 'memory');
  await mkdir(memDir, { recursive: true });

  // Write daily files
  for (const [date, contents] of byDate) {
    const dailyPath = join(memDir, `${date}.md`);
    await writeFile(dailyPath, `## ${date}\n${contents.join('\n')}\n`, 'utf8');
    console.log(`    -> memory/${date}.md`);
  }

  // Generate curated MEMORY.md
  console.log(`    -> generating curated MEMORY.md...`);
  const curated = await curate(content);
  await writeFile(join(memDir, 'MEMORY.md'), curated + '\n', 'utf8');
  console.log(`    -> MEMORY.md (${curated.split('\n').length} lines)`);

  // Back up old file
  await rename(memoryPath, memoryPath + '.bak');
  console.log(`    -> memory.md renamed to memory.md.bak`);
}

async function main() {
  console.log(DRY_RUN ? 'DRY RUN — no changes will be made\n' : '');
  console.log('Migrating student memory files to OpenClaw workspace format...\n');

  const students = await listStudentDirs();
  if (students.length === 0) {
    console.log('No student directories found in', DATA_DIR);
    return;
  }

  console.log(`Found ${students.length} student(s)\n`);

  for (const dir of students) {
    await migrateStudent(dir);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
