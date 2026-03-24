/**
 * Google Calendar OAuth handler.
 * Manages the OAuth flow initiated from the calendar-connect web page.
 */

import { getAuthUrl, exchangeCode } from '../lib/calendar-client.js';
import { saveGCalTokens } from '../lib/student-store.js';
import { updateProfile } from '../lib/student-store.js';
import { validateSetupToken, lookupToken } from './setup-tokens.js';

/**
 * Handle the initial calendar connect page request.
 * GET /connect/calendar/:token
 */
export function handleConnectPage(req, res) {
  const { token } = req.params;
  const phone = lookupToken(token);

  if (!phone) {
    return res.status(400).send(expiredPage());
  }

  // Serve the connect page
  res.sendFile('calendar-connect.html', {
    root: new URL('../../web', import.meta.url).pathname,
  });
}

/**
 * Start the OAuth flow when user clicks "Connect Google Calendar".
 * GET /connect/calendar/:token/auth
 */
export function handleAuthStart(req, res) {
  const { token } = req.params;
  const phone = lookupToken(token);

  if (!phone) {
    return res.status(400).send(expiredPage());
  }

  const authUrl = getAuthUrl(token);
  res.redirect(authUrl);
}

/**
 * Handle the OAuth callback from Google.
 * GET /connect/calendar/callback
 */
export async function handleAuthCallback(req, res) {
  const { code, state: token } = req.query;

  if (!code || !token) {
    return res.status(400).send(errorPage());
  }

  // Validate and consume the setup token
  const phone = validateSetupToken(token);
  if (!phone) {
    return res.status(400).send(expiredPage());
  }

  try {
    const tokens = await exchangeCode(code);
    await saveGCalTokens(phone, tokens);
    await updateProfile(phone, { calendar_connected: true });
    res.send(successPage());
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(errorPage());
  }
}

function successPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connected! - StudyClaw</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="icon">&#10003;</div>
      <h1>Connected!</h1>
      <p>Your Google Calendar is linked. Head back to your texts.</p>
    </div>
  </div>
</body>
</html>`;
}

function expiredPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Expired - StudyClaw</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Link expired</h1>
      <p>This setup link has expired or was already used. Text StudyClaw and ask for a new one.</p>
    </div>
  </div>
</body>
</html>`;
}

function errorPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Something went wrong - StudyClaw</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Something went wrong</h1>
      <p>We couldn't connect your calendar. Text StudyClaw and we'll send you a new link.</p>
    </div>
  </div>
</body>
</html>`;
}
