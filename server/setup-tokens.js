/**
 * Generates and validates one-time setup tokens for linking
 * Google Calendar OAuth to a student's phone number.
 */

import { randomBytes } from 'node:crypto';

// In-memory store. At scale, move this to Redis or a database.
const tokens = new Map();

const EXPIRY_MS = 60 * 60 * 1000; // 1 hour

/**
 * Generate a setup token tied to a phone number.
 * Returns the token string (used in the OAuth URL).
 */
export function generateSetupToken(phone) {
  // Invalidate any existing token for this phone
  for (const [token, data] of tokens) {
    if (data.phone === phone) tokens.delete(token);
  }

  const token = randomBytes(24).toString('base64url');
  tokens.set(token, {
    phone,
    createdAt: Date.now(),
    used: false,
  });

  return token;
}

/**
 * Validate a setup token. Returns the phone number if valid, null if not.
 * Marks the token as used (single-use).
 */
export function validateSetupToken(token) {
  const data = tokens.get(token);
  if (!data) return null;
  if (data.used) return null;
  if (Date.now() - data.createdAt > EXPIRY_MS) {
    tokens.delete(token);
    return null;
  }

  data.used = true;
  return data.phone;
}

/**
 * Look up phone number for a token without consuming it.
 * Used during the OAuth flow before the callback.
 */
export function lookupToken(token) {
  const data = tokens.get(token);
  if (!data) return null;
  if (data.used) return null;
  if (Date.now() - data.createdAt > EXPIRY_MS) {
    tokens.delete(token);
    return null;
  }
  return data.phone;
}

// Clean up expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tokens) {
    if (now - data.createdAt > EXPIRY_MS * 2) {
      tokens.delete(token);
    }
  }
}, 10 * 60 * 1000); // every 10 minutes
