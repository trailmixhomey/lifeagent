/**
 * WhatsApp listener for StudyClaw.
 * Uses Baileys (WhatsApp Web) to send and receive messages.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import pino from 'pino';
import { processMessage } from './sms-handler.js';
import { getProfile, updateProfile } from '../lib/student-store.js';

const AUTH_DIR = join(process.cwd(), 'data', 'whatsapp-auth');

// Quiet logger — only show warnings and errors, not every protocol frame
const logger = pino({ level: 'warn' });

let sock = null;
let status = 'disconnected'; // disconnected | waiting_for_scan | connected
let qrCode = null;
let qrResolve = null; // resolves when a QR code is generated
let connectionResolve = null; // resolves when connection completes
let reconnectAttempts = 0;

/**
 * Get the current WhatsApp connection status.
 */
export function getWhatsAppStatus() {
  return {
    status,
    phone: sock?.user?.id ? sock.user.id.split(':')[0] : null,
    listening: status === 'connected',
    qr: qrCode || null,
  };
}

/**
 * Start the QR code login flow.
 * Returns a promise that resolves with the QR string when available.
 */
export function waitForQr() {
  if (qrCode) return Promise.resolve(qrCode);
  return new Promise((resolve) => {
    qrResolve = resolve;
  });
}

/**
 * Wait for connection to complete after QR scan.
 */
export function waitForConnection() {
  if (status === 'connected') return Promise.resolve(true);
  return new Promise((resolve) => {
    connectionResolve = resolve;
  });
}

/**
 * Start the WhatsApp socket.
 * Fetches the latest protocol version, then connects.
 * If credentials exist, connects automatically.
 * If not, generates a QR code for scanning.
 */
export async function startWhatsAppListener() {
  await mkdir(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  // Fetch the latest WhatsApp Web version to avoid protocol rejection
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCode = qr;
      status = 'waiting_for_scan';
      console.log('WhatsApp QR code ready — scan at /admin/whatsapp');
      if (qrResolve) {
        qrResolve(qr);
        qrResolve = null;
      }
    }

    if (connection === 'open') {
      status = 'connected';
      qrCode = null;
      reconnectAttempts = 0;
      console.log('WhatsApp connected as', sock.user?.id?.split(':')[0]);
      if (connectionResolve) {
        connectionResolve(true);
        connectionResolve = null;
      }
    }

    if (connection === 'close') {
      status = 'disconnected';
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log('WhatsApp logged out. Visit /admin/whatsapp to re-link.');
        return;
      }

      // Exponential backoff: 5s, 10s, 20s, 40s, max 60s
      reconnectAttempts++;
      const delay = Math.min(5_000 * Math.pow(2, reconnectAttempts - 1), 60_000);
      console.log(`WhatsApp disconnected (code ${code}), reconnecting in ${delay / 1000}s...`);
      setTimeout(() => startWhatsAppListener().catch(console.error), delay);
    }
  });

  // Handle incoming messages
  sock.ev.on('messages.upsert', async (upsert) => {
    const messages = upsert.messages || [];
    const type = upsert.type;

    console.log(`[WA] messages.upsert: type=${type}, count=${messages.length}`);

    for (const msg of messages) {
      // Skip messages from self, groups, status broadcasts
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        null;

      const imageMessage = msg.message?.imageMessage;
      const documentMessage = msg.message?.documentMessage;
      const hasMedia = !!(imageMessage || documentMessage);

      console.log(`[WA] from=${msg.key.remoteJid} participant=${msg.key.participant || 'none'} pushName=${msg.pushName || 'none'} body=${body ? body.slice(0, 50) : '(no text)'} media=${hasMedia}`);

      if (!body && !hasMedia) continue;

      // Resolve phone number from JID
      const jid = msg.key.remoteJid;
      let phone;

      if (jid.endsWith('@s.whatsapp.net')) {
        // Standard JID: 15551234567@s.whatsapp.net → +15551234567
        phone = '+' + jid.split('@')[0];
      } else if (jid.endsWith('@lid')) {
        // LID (Linked ID) — look up via participant or contact store
        const participant = msg.key.participant;
        if (participant && participant.endsWith('@s.whatsapp.net')) {
          phone = '+' + participant.split('@')[0];
        } else {
          // Use pushName as display identifier, store messages by LID
          phone = '+' + jid.split('@')[0];
          console.log(`[WA] Using LID as phone identifier for ${msg.pushName || 'unknown'}`);
        }
      } else {
        phone = '+' + jid.split('@')[0];
      }

      // Download media if present (image or document)
      let mediaData = null;
      if (hasMedia) {
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const mimeType = imageMessage?.mimetype || documentMessage?.mimetype || 'image/jpeg';
          mediaData = { base64: buffer.toString('base64'), mimeType };
          console.log(`[WA] Downloaded media: ${mimeType}, ${buffer.length} bytes`);
        } catch (err) {
          console.error(`[WA] Failed to download media from ${phone}:`, err.message);
        }
      }

      try {
        // Show typing indicator
        await sock.sendPresenceUpdate('composing', jid);

        const response = await processMessage(phone, body || '', mediaData);
        if (response) {
          const replies = Array.isArray(response) ? response : [response];
          for (const text of replies) {
            await sendMessage(jid, text);
          }
        }

        await sock.sendPresenceUpdate('paused', jid);
      } catch (err) {
        console.error(`Error processing WhatsApp message from ${phone}:`, err);
        await sendMessage(jid, "Hey, I hit a snag on my end. Try again in a sec?");
      }

      // Persist the reply JID so cron jobs can reach LID-only users
      await updateProfile(phone, { replyJid: jid }).catch(() => {});
    }
  });
}

/**
 * Send a WhatsApp message to a phone number.
 * Splits long messages into chunks (WhatsApp supports ~4000 chars).
 */
export async function sendMessage(to, body) {
  if (!sock || status !== 'connected') {
    throw new Error('WhatsApp not connected');
  }

  let jid;
  if (to.includes('@')) {
    // Already a JID (e.g., 55628785557680@lid or 15551234567@s.whatsapp.net)
    jid = to;
  } else {
    // Phone number — check for stored reply JID (handles LID routing for cron jobs)
    const profile = await getProfile(to);
    jid = profile?.replyJid || (to.replace('+', '') + '@s.whatsapp.net');
  }

  const chunks = splitMessage(body, 4000);
  for (const chunk of chunks) {
    await sock.sendMessage(jid, { text: chunk });
  }
}

/**
 * Get the active socket (for advanced usage).
 */
export function getSocket() {
  return sock;
}

/**
 * Split a long message into chunks at natural break points.
 */
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      splitIdx = remaining.lastIndexOf('. ', maxLen);
      if (splitIdx > 0) splitIdx += 1;
    }
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
