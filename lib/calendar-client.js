/**
 * Google Calendar API client.
 * Wraps googleapis for reading events and creating study blocks.
 * googleapis is lazy-loaded because it's a huge package that slows startup.
 */

let google = null;

async function getGoogle() {
  if (!google) {
    const mod = await import('googleapis/build/src/index.js');
    google = mod.google;
  }
  return google;
}

async function getOAuth2Client() {
  const g = await getGoogle();
  return new g.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Create an authenticated calendar client from stored tokens.
 */
export async function createCalendarClient(tokens) {
  const g = await getGoogle();
  const auth = await getOAuth2Client();
  auth.setCredentials(tokens);

  auth.on('tokens', (newTokens) => {
    if (newTokens.refresh_token) {
      tokens.refresh_token = newTokens.refresh_token;
    }
    tokens.access_token = newTokens.access_token;
    tokens.expiry_date = newTokens.expiry_date;
  });

  const calendar = g.calendar({ version: 'v3', auth });
  return { calendar, auth, tokens };
}

/**
 * Get the OAuth2 authorization URL for a student to connect their calendar.
 */
export async function getAuthUrl(state) {
  const auth = await getOAuth2Client();
  return auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    state,
  });
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(code) {
  const auth = await getOAuth2Client();
  const { tokens } = await auth.getToken(code);
  return tokens;
}

/**
 * Get events from the student's primary calendar within a date range.
 */
export async function getEvents(tokens, timeMin, timeMax) {
  const { calendar } = await createCalendarClient(tokens);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });

  return (res.data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || '(No title)',
    start: e.start.dateTime || e.start.date,
    end: e.end.dateTime || e.end.date,
    allDay: !e.start.dateTime,
  }));
}

/**
 * Create a study block event on the student's calendar.
 */
export async function createStudyEvent(tokens, {
  eventTitle,
  dueDate,
  startTime,
  endTime,
  timezone,
}) {
  const { calendar } = await createCalendarClient(tokens);

  const event = {
    summary: eventTitle,
    description: dueDate ? `Due ${dueDate}. Created by StudyClaw.` : 'Created by StudyClaw.',
    start: {
      dateTime: startTime,
      timeZone: timezone,
    },
    end: {
      dateTime: endTime,
      timeZone: timezone,
    },
    colorId: '1', // lavender
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 10 }],
    },
  };

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event,
  });

  return res.data;
}

/**
 * Update an existing calendar event. Only provided fields are changed.
 */
export async function updateCalendarEvent(tokens, {
  eventId,
  eventTitle,
  startTime,
  endTime,
  timezone,
}) {
  const { calendar } = await createCalendarClient(tokens);

  const patch = {};
  if (eventTitle) patch.summary = eventTitle;
  if (startTime) patch.start = { dateTime: startTime, timeZone: timezone };
  if (endTime) patch.end = { dateTime: endTime, timeZone: timezone };

  const res = await calendar.events.patch({
    calendarId: 'primary',
    eventId,
    requestBody: patch,
  });

  return res.data;
}

/**
 * Delete a calendar event.
 */
export async function deleteCalendarEvent(tokens, eventId) {
  const { calendar } = await createCalendarClient(tokens);

  await calendar.events.delete({
    calendarId: 'primary',
    eventId,
  });
}

/**
 * Classify a Google Calendar error into a human-friendly message.
 */
export function classifyCalendarError(err) {
  if (err.code === 401 || err.code === 403) {
    return {
      type: 'auth',
      message: "I need to reconnect to your calendar. I'll send you a new link.",
    };
  }
  return {
    type: 'unknown',
    message: "Having trouble with your calendar right now — I'll try again shortly.",
  };
}
