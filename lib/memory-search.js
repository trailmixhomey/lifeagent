/**
 * Semantic memory search using OpenAI embeddings.
 * Caches embeddings per student in memory/.embeddings.json.
 * Falls back to full curated memory if OPENAI_API_KEY is not set.
 */

import OpenAI from 'openai';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getCuratedMemory,
  getRecentMemory,
} from './student-store.js';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const MAX_RESULTS = 8;

let openai = null;

function getClient() {
  if (!openai && process.env.OPENAI_API_KEY) {
    openai = new OpenAI();
  }
  return openai;
}

function memoryDir(phone) {
  const DATA_DIR = join(process.cwd(), 'data', 'students');
  return join(DATA_DIR, phone.replace('+', ''), 'memory');
}

function splitIntoBullets(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-') || l.startsWith('*'))
    .map((l) => l.replace(/^[-*]\s*(\[[ x!]\]\s*)?/, '').trim())
    .filter((l) => l.length > 5);
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function loadEmbeddingCache(phone) {
  const cachePath = join(memoryDir(phone), '.embeddings.json');
  try {
    const raw = await readFile(cachePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { version: 1, entries: {} };
  }
}

async function saveEmbeddingCache(phone, cache) {
  const cachePath = join(memoryDir(phone), '.embeddings.json');
  await writeFile(cachePath, JSON.stringify(cache), 'utf8');
}

async function embedTexts(texts) {
  const client = getClient();
  if (!client) return null;

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

/**
 * Search a student's memory for facts relevant to a query.
 * Returns the most relevant bullet points from curated + recent memory.
 * Falls back to full curated memory if embeddings are unavailable.
 */
export async function searchMemory(phone, query, maxResults = MAX_RESULTS) {
  const client = getClient();

  // Fallback: no OpenAI key configured — return full curated memory
  if (!client) {
    return getCuratedMemory(phone);
  }

  // Gather all memory bullets
  const curated = await getCuratedMemory(phone);
  const recent = await getRecentMemory(phone, 7);
  const allText = [curated, recent].filter(Boolean).join('\n');
  const bullets = splitIntoBullets(allText);

  if (bullets.length === 0) return '';
  if (bullets.length <= maxResults) return allText;

  // Load embedding cache
  const cache = await loadEmbeddingCache(phone);
  const uncached = bullets.filter((b) => !cache.entries[b]);

  // Embed uncached bullets
  if (uncached.length > 0) {
    try {
      const embeddings = await embedTexts(uncached);
      if (embeddings) {
        for (let i = 0; i < uncached.length; i++) {
          cache.entries[uncached[i]] = embeddings[i];
        }
        await saveEmbeddingCache(phone, cache);
      }
    } catch (err) {
      // Embedding failed — fall back to full memory
      console.error('Memory search embedding error:', err.message);
      return curated || '';
    }
  }

  // Embed query
  let queryEmbedding;
  try {
    const result = await embedTexts([query]);
    if (!result) return curated || '';
    queryEmbedding = result[0];
  } catch {
    return curated || '';
  }

  // Rank bullets by similarity
  const scored = bullets
    .filter((b) => cache.entries[b])
    .map((b) => ({
      text: b,
      score: cosineSimilarity(queryEmbedding, cache.entries[b]),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  if (scored.length === 0) return curated || '';

  return scored.map((s) => `- ${s.text}`).join('\n');
}
