/**
 * StudyClaw — main entry point.
 * Starts the Express server with Google OAuth routes, test console,
 * WhatsApp messaging via OpenClaw, and cron-based proactive nudges.
 */

import 'dotenv/config';
import express from 'express';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './routes.js';
import { startCronJobs } from './cron-runner.js';
import { startWhatsAppListener } from './whatsapp-listener.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Parse form data and JSON (for test console and OAuth)
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '10mb' }));

// Serve static files (CSS for the OAuth page)
const webDir = join(fileURLToPath(import.meta.url), '..', '..', 'web');
app.use(express.static(webDir));

// Mount routes
app.use(routes);

// Start server
app.listen(PORT, async () => {
  console.log(`StudyClaw running on port ${PORT}`);
  startCronJobs();

  startWhatsAppListener().catch((err) => {
    console.error('WhatsApp listener error:', err.message);
  });
  console.log(`WhatsApp setup: http://localhost:${PORT}/admin/whatsapp`);
});
