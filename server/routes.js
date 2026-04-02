/**
 * Express routes for StudyClaw.
 * Handles Google OAuth, calendar connect page, and test console.
 */

import { Router } from 'express';
import { handleConnectPage, handleAuthStart, handleAuthCallback } from './oauth-google.js';
import { processMessage } from './sms-handler.js';
import {
  getWhatsAppStatus,
  waitForQr,
  waitForConnection,
} from './whatsapp-listener.js';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { rm, readFile } from 'node:fs/promises';

const router = Router();

// --- WhatsApp Admin Setup ---
router.get('/admin/whatsapp', (req, res) => {
  const webDir = join(fileURLToPath(import.meta.url), '..', '..', 'web');
  res.sendFile(join(webDir, 'whatsapp-setup.html'));
});

router.get('/admin/whatsapp/status', (req, res) => {
  res.json(getWhatsAppStatus());
});

router.get('/admin/whatsapp/qr', async (req, res) => {
  try {
    const qr = await waitForQr();
    res.json({ qr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/whatsapp/wait', async (req, res) => {
  try {
    await waitForConnection();
    res.json(getWhatsAppStatus());
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// --- Google Calendar OAuth ---
router.get('/connect/calendar/callback', handleAuthCallback);
router.get('/connect/calendar/:token/auth', handleAuthStart);
router.get('/connect/calendar/:token', handleConnectPage);

// --- Test Console (local dev only) ---
router.get('/test', (req, res) => {
  const webDir = join(fileURLToPath(import.meta.url), '..', '..', 'web');
  res.sendFile(join(webDir, 'test-console.html'));
});

router.post('/test/send', async (req, res) => {
  const { phone, message, image } = req.body;
  if (!phone || (!message && !image)) {
    return res.json({ error: 'Missing phone or message/image' });
  }
  try {
    let mediaData = null;
    if (image) {
      mediaData = { base64: image.base64, mimeType: image.mimeType };
    }
    const response = await processMessage(phone, message || '', mediaData);
    res.json({ response: Array.isArray(response) ? response : [response] });
  } catch (err) {
    console.error('Test console error:', err);
    res.json({ error: err.message });
  }
});

router.post('/test/memory', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.json({ memory: '' });
  const filePath = join(process.cwd(), 'data', 'students', phone.replace('+', ''), 'memory.md');
  try {
    const content = await readFile(filePath, 'utf8');
    res.json({ memory: content });
  } catch {
    res.json({ memory: '(no memories yet)' });
  }
});

router.post('/test/reset', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.json({ error: 'Missing phone' });
  const dir = join(process.cwd(), 'data', 'students', phone.replace('+', ''));
  await rm(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// --- Health Check ---
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'studyclaw' });
});

export default router;
