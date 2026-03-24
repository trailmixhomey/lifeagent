/**
 * Express routes for StudyClaw.
 * Handles Twilio SMS webhooks, Google OAuth, and the calendar connect page.
 */

import { Router } from 'express';
import { handleConnectPage, handleAuthStart, handleAuthCallback } from './oauth-google.js';
import { handleInboundSms } from './sms-handler.js';

const router = Router();

// --- SMS Webhook ---
router.post('/sms/inbound', handleInboundSms);

// --- Google Calendar OAuth ---
router.get('/connect/calendar/callback', handleAuthCallback);
router.get('/connect/calendar/:token/auth', handleAuthStart);
router.get('/connect/calendar/:token', handleConnectPage);

// --- Health Check ---
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'studyclaw' });
});

export default router;
