/**
 * StudyClaw — main entry point.
 * Starts the Express server with Twilio webhooks, Google OAuth routes,
 * and cron-based proactive nudges.
 */

import 'dotenv/config';
import express from 'express';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './routes.js';
import { startCronJobs } from './cron-runner.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Parse Twilio webhook form data and JSON
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Serve static files (CSS for the OAuth page)
const webDir = join(fileURLToPath(import.meta.url), '..', '..', 'web');
app.use(express.static(webDir));

// Mount routes
app.use(routes);

// Start server
app.listen(PORT, () => {
  console.log(`StudyClaw running on port ${PORT}`);
  startCronJobs();
});
