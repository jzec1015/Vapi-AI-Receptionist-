import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createBooking } from './booking.mjs';

export function conversationKey(message) {
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
  // Keep voice IDs unchanged so deployed records retain their retry identity.
  if (message.call != null) return valid(message.call.id) ? message.call.id : null;
  const sessionId = message.session?.id ?? message.chat?.sessionId;
  if (sessionId != null) return valid(sessionId) ? `session:${sessionId}` : null;
  return valid(message.chat?.id) ? `chat:${message.chat.id}` : null;
}

export function assistantIdOf(message) {
  return message.call?.assistantId || message.assistant?.id || message.chat?.assistantId || null;
}

export function callerNumberOf(message) {
  const number = message.call?.customer?.number || message.customer?.number;
  return typeof number === 'string' && number.length <= 40 ? number : '';
}

const digitsOf = value => String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const listOf = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

// Why a request is test traffic, or null for a live request. Test requests are stored but
// flagged, never alert a client or email a caller, and are excluded from live counts.
//   explicit        the receptionist marked it (caller said "this is a test call")
//   chat            dashboard/API chat sessions (Emma takes live jobs by phone only)
//   test_assistant  assistant listed in TEST_ASSISTANT_IDS (demo / staging assistants)
//   test_number     caller ID or callback number listed in TEST_CALLER_NUMBERS (Jake's phones, voicetest line)
export function testReason(env, { explicit = false, callId = '', assistantId = '', callerId = '', callbackPhone = '' }) {
  if (explicit) return 'explicit';
  if (/^(chat|session):/.test(callId)) return 'chat';
  if (assistantId && listOf(env.TEST_ASSISTANT_IDS).includes(assistantId)) return 'test_assistant';
  const numbers = new Set(listOf(env.TEST_CALLER_NUMBERS).map(digitsOf).filter(Boolean));
  if ([callerId, callbackPhone].some(n => numbers.has(digitsOf(n)))) return 'test_number';
  return null;
}

// US numbers read as (615) 555-0142; anything else is shown as given.
export function formatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : String(value || '');
}

// Plain-text office alert. GSM-7 only (no emoji, no smart quotes) so a full alert is at most
// 3 SMS segments; one non-GSM character would switch the whole text to UCS-2 (70 chars/segment).
// Carrier rules: the sender brand (Anchorline AI) is named and every text carries an opt-out line,
// matching the registered 10DLC campaign samples.
const gsm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"')
  .replace(/[\u2013\u2014\u00B7\u2022]/g, '-').replace(/\u2026/g, '...').replace(/[^\n\x20-\x7E]/g, '');
export function alertText(route, details, kind = 'new') {
  const urgent = /^\s*URGENT\b/i.test(details.issue);
  const head = kind === 'note' ? (urgent ? 'URGENT update' : 'Update') : kind === 'hangup' ? 'Caller hung up' : urgent ? 'URGENT call' : 'New call';
  const phone = details.callback_phone ? formatPhone(details.callback_phone) : (details.caller_id ? `${formatPhone(details.caller_id)} (caller ID)` : 'no number given');
  const issue = details.issue.replace(/^\s*URGENT\s*-\s*/i, '');
  const lines = [`Anchorline AI: ${head}${route.business ? ` - ${route.business}` : ''}`, `${details.name} - ${phone}`];
  if (details.address) lines.push(details.address);
  lines.push(kind === 'note' ? `Note: ${details.notes.at(-1)}` : issue);
  if (kind === 'new' && (details.job_type || details.job_size)) lines.push(`Job: ${[details.job_type, details.job_size].filter(Boolean).join(' - ')}`);
  if (kind === 'new' && details.job_details) lines.push(`Details: ${details.job_details}`);
  if (kind === 'new' && details.preferred_time) lines.push(`Wants: ${details.preferred_time}`);
  return `${gsm(lines.join('\n')).slice(0, 280)}\nReply STOP to opt out`;
}

// Customer confirmation: what we received, never a promised appointment time.
export function confirmationEmail(route, details, id) {
  const issue = details.issue.replace(/^\s*URGENT\s*-\s*/i, '');
  const phone = formatPhone(details.callback_phone || details.caller_id) || 'The number you called from';
  const when = details.preferred_time ? `${details.preferred_time} (the team will call to confirm)` : 'The team will call you to set a time';
  return {
    subject: `${route.business}: we received your request`,
    text: `Hi ${details.name},

Thanks for calling ${route.business}. We received your service request, and our team will be in touch soon.

` +
      `Name: ${details.name}
Phone: ${phone}
Service address: ${details.address}
Issue: ${issue}
Requested time: ${when}

` +
      `If anything here is wrong, just reply to this email.

${route.business}
Reference: ${id.slice(0, 8)}`
  };
}

// Spoken alert for urgent jobs: reads the job once, repeats on request, then hangs up.
// missedTransfer: the caller was offered a live transfer that nobody picked up.
export function alertCall(route, details, phoneNumberId, to, missedTransfer = false) {
  const issue = details.issue.replace(/^\s*URGENT\s*-\s*/i, '');
  const phone = details.callback_phone ? formatPhone(details.callback_phone) : details.caller_id ? formatPhone(details.caller_id) : 'no number given';
  const job = `${details.name}, at ${details.address || 'no address given'}. ${issue}. Callback number: ${phone}.`;
  const missed = missedTransfer ? ' I tried to put them through to you live but couldn\'t reach you, so please call them back.' : '';
  return {
    phoneNumberId, customer: { number: to },
    assistant: {
      name: 'Urgent job alert', maxDurationSeconds: 90, endCallFunctionEnabled: true, firstMessageMode: 'assistant-speaks-first',
      firstMessage: `Hi, this is an urgent job alert for ${route.business}. ${job}${missed} It's also in your email. Want me to repeat that?`,
      voice: { provider: '11labs', voiceId: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_turbo_v2_5' },
      model: { provider: 'openai', model: 'gpt-4.1', maxTokens: 120, messages: [{ role: 'system', content:
        `You just delivered this urgent job alert for ${route.business}: ${job} If asked, repeat it slowly, especially the callback number. ` +
        'You cannot do anything else. When they say thanks, no, or goodbye, say a short goodbye and end the call.' }] }
    }
  };
}

export const isE164 = value => typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);

// Warm transfer of an urgent caller to the owner's cell (Vapi transfer-destination-request reply).
// The owner hears the saved job (confirmed details, not a generated summary) and must accept before the
// caller is connected. Voicemail, no answer or a decline returns the caller to Emma (fallbackPlan).
export function transferDestination(route, details) {
  const issue = details.issue.replace(/^\s*URGENT\s*-\s*/i, '');
  const phone = details.callback_phone ? formatPhone(details.callback_phone) : details.caller_id ? formatPhone(details.caller_id) : 'no number given';
  const intro = `Hi, it's Emma from ${route.business} with an urgent caller on hold: ${details.name}, at ${details.address || 'no address given'}. ${issue}. ` +
    `Their number is ${phone}. Can you take the call now?`;
  return {
    type: 'number', number: route.transfer, callerId: '{{phoneNumber.number}}',
    transferPlan: {
      mode: 'warm-transfer-experimental',
      contextEngineeringPlan: { type: 'none' },
      transferAssistant: {
        firstMessageMode: 'assistant-waits-for-user', maxDurationSeconds: 45, silenceTimeoutSeconds: 20,
        voice: { provider: '11labs', voiceId: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_turbo_v2_5' },
        model: { provider: 'openai', model: 'gpt-4.1', maxTokens: 120, messages: [{ role: 'system', content:
          `You are Emma, calling the owner of ${route.business} to hand over an urgent caller who is on hold. ` +
          `When a live person answers, say exactly: "${intro}" ` +
          'If they accept (yes, sure, go ahead, put them through), call transferSuccessful right away without saying more. ' +
          'If you hear voicemail, a recorded greeting, an automated message or a busy signal, call transferCancel at once and say nothing about the caller. ' +
          'If they say no, they cannot, or ask you to take a message, call transferCancel. If asked, repeat the details slowly, especially the number. ' +
          'Keep every reply to one short sentence.' }] }
      },
      fallbackPlan: { message: 'I couldn\'t get the owner on the line just now. Your request is already saved for the team. One moment.', endCallEnabled: false }
    }
  };
}

export function createApp(env = process.env, send = fetch) {
  const dataDir = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR;
  const key = env.VAPI_WEBHOOK_SECRET || '';
  // ALERT_ROUTES: {"<assistantId>": {"business": "...", "sms": ["+1..."], "email": ["..."], "call": ["+1..."], "alertTests": false}}
  // "call" numbers get a spoken alert for URGENT jobs (needs VAPI_API_KEY and ALERT_CALL_FROM_ID).
  // "transfer": "+1..." (owner's cell) enables a live warm transfer for URGENT jobs. The spoken alert call then waits
  // until the transfer is not answered, and is placed anyway after TRANSFER_FALLBACK_SECONDS unless the caller was connected.
  let routes = {};
  try { routes = JSON.parse(env.ALERT_ROUTES || '{}') || {}; } catch { routes = {}; }
  const routeFor = message => routes[assistantIdOf(message)] || null;
  const fallbackMs = Math.max(0, Number(env.TRANSFER_FALLBACK_SECONDS ?? 75) || 0) * 1000;
  const canTransfer = (route, details) => !!route && isE164(route.transfer) && /^\s*URGENT\b/i.test(details.issue) && (!details.is_test || !!route.alertTests);
  let db;
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(join(dataDir, 'requests.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS requests (
        call_id TEXT PRIMARY KEY, id TEXT NOT NULL, created_at TEXT NOT NULL,
        details TEXT NOT NULL, result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfers (
        call_id TEXT PRIMARY KEY, assistant_id TEXT, status TEXT NOT NULL, due_at INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookings (call_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, result TEXT NOT NULL);`);
    // v1.6: queryable assistant and test columns, so live data can be filtered and test rows purged safely.
    // They are VIRTUAL generated columns read from the details JSON, so the table still takes 5 values and a
    // rollback to v1.5.0 (which inserts with VALUES (?, ?, ?, ?, ?)) keeps saving requests. One transaction:
    // a failed migration leaves the v1.5.0 table as it was.
    const columns = new Set(db.prepare('PRAGMA table_xinfo(requests)').all().map(c => c.name));
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!columns.has('assistant_id')) db.exec(`ALTER TABLE requests ADD COLUMN assistant_id TEXT
        GENERATED ALWAYS AS (CASE WHEN json_valid(details) THEN json_extract(details, '$.assistant_id') END) VIRTUAL`);
      if (!columns.has('is_test')) db.exec(`UPDATE requests SET details = json_set(details, '$.is_test', json('true'), '$.test_reason', 'chat')
          WHERE (call_id LIKE 'chat:%' OR call_id LIKE 'session:%') AND CASE WHEN json_valid(details) THEN json_extract(details, '$.is_test') IS NOT 1 ELSE 0 END;
        ALTER TABLE requests ADD COLUMN is_test INTEGER
          GENERATED ALWAYS AS (CASE WHEN NOT json_valid(details) THEN 0 WHEN json_extract(details, '$.is_test') = 1 THEN 1 ELSE 0 END) VIRTUAL;`);
      db.exec('CREATE INDEX IF NOT EXISTS requests_live ON requests (is_test, assistant_id, created_at); COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Column list matches the v1.5.0 table; assistant_id and is_test are derived from details.
  const insert = (orIgnore, callId, id, details, result, assistantId) => db.prepare(
    `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO requests (call_id, id, created_at, details, result) VALUES (?, ?, ?, ?, ?)`
  ).run(callId, id, new Date().toISOString(), JSON.stringify({ ...details, is_test: !!details.is_test, assistant_id: assistantId || null }), JSON.stringify(result));
  // Marks details as a test when any rule matches (see testReason). Mutates and returns details.
  const classify = (details, callId, message) => {
    const reason = testReason(env, { explicit: details.is_test === true, callId, assistantId: assistantIdOf(message) || '',
      callerId: details.caller_id, callbackPhone: details.callback_phone });
    details.is_test = !!reason;
    if (reason) details.test_reason = reason;
    return details;
  };
  // Booking into the client's scheduling tool (off unless BOOKING_ROUTES names the assistant).
  const booking = createBooking(env, send, {
    get: callId => { const row = db?.prepare('SELECT result FROM bookings WHERE call_id = ?').get(callId); return row ? JSON.parse(row.result) : undefined; },
    set: (callId, result) => db?.prepare('INSERT OR IGNORE INTO bookings VALUES (?, ?, ?)').run(callId, new Date().toISOString(), JSON.stringify(result))
  });
  const savedRequest = callId => {
    const row = db.prepare('SELECT id, details FROM requests WHERE call_id = ?').get(callId);
    return row ? { ...JSON.parse(row.details), request_id: row.id } : null;
  };
  const authorized = req => {
    const supplied = Buffer.from(String(req.headers['x-anchorline-key'] || ''));
    const expected = Buffer.from(key);
    return expected.length >= 32 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const failure = (error, retryable = false) => ({ saved: false, retryable, error });
  const inflight = new Map();
  async function receipt(to, details, id, recipient, route = null) {
    if (!to) return 'not_requested';
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return 'needs_review';
    const branded = recipient === 'caller' && route?.business;
    const message = branded ? confirmationEmail(route, details, id) : { subject: 'Anchorline service request received',
      text: `Request reference: ${id}

Name: ${details.name}
Address: ${details.address}
Issue: ${details.issue}
Callback: ${details.callback_phone || 'Not provided'}

This records a request only. It does not confirm an appointment, dispatch, transfer, or callback.` };
    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${id}-${recipient}` },
        body: JSON.stringify({ from: branded ? `${route.business} <${env.EMAIL_FROM}>` : env.EMAIL_FROM, to: [to], ...message,
          ...(branded && route.email?.length ? { reply_to: route.email } : {}) })
      });
      return response.ok ? 'accepted' : 'needs_review';
    } catch { return 'needs_review'; }
  }
  // Spoken alert calls to a route's "call" numbers (urgent jobs only).
  function phoneAlerts(route, details, missedTransfer = false) {
    if (!env.VAPI_API_KEY || !env.ALERT_CALL_FROM_ID) return [];
    return (route.call || []).map(to => send('https://api.vapi.ai/call', {
      method: 'POST', signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(alertCall(route, details, env.ALERT_CALL_FROM_ID, to, missedTransfer)) }));
  }
  // Office alerts for one client route. Returns a status string; never throws.
  // holdCall: a live transfer will be tried first, so the spoken alert call waits for its outcome.
  async function alert(route, details, id, kind, holdCall = false) {
    if (!route || (details.is_test && !route.alertTests)) return details.is_test ? 'suppressed_test' : 'not_configured';
    const text = alertText(route, details, kind);
    const jobs = [];
    if (env.TELNYX_API_KEY && env.TELNYX_FROM) {
      for (const to of route.sms || []) jobs.push(send('https://api.telnyx.com/v2/messages', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.TELNYX_FROM, to, text }) }).then(async r => {
          // Log only Telnyx error codes (e.g. 40300 recipient opted out, 40010 number not 10DLC-linked), never the text.
          if (!r.ok) { let codes = ''; try { codes = (await r.clone().json()).errors?.map(e => e.code).join(',') || ''; } catch {}
            console.warn(`sms alert failed: HTTP ${r.status} ${codes}`); }
          return r;
        }));
    }
    if (env.RESEND_API_KEY && env.EMAIL_FROM && (route.email || []).length) {
      jobs.push(send('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${id}-alert-${kind}-${details.notes.length}` },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: route.email, subject: text.split('\n')[0], text: `${text}\n\nRequest reference: ${id}` }) }));
    }
    const urgent = /^\s*URGENT\b/i.test(details.issue);
    if (kind === 'new' && urgent && !holdCall) jobs.push(...phoneAlerts(route, details));
    return settle(jobs);
  }
  async function settle(jobs) {
    if (!jobs.length) return 'not_configured';
    const settled = await Promise.allSettled(jobs);
    return settled.every(s => s.status === 'fulfilled' && s.value.ok) ? 'sent' : 'needs_review';
  }
  // Live transfer bookkeeping. One row per call; the held alert call is placed at most once.
  const transferRow = callId => db.prepare('SELECT status, due_at FROM transfers WHERE call_id = ?').get(callId);
  function setTransfer(callId, status, from) {
    const placeholders = from.map(() => '?').join(', ');
    return db.prepare(`UPDATE transfers SET status = ?, updated_at = ? WHERE call_id = ? AND status IN (${placeholders})`)
      .run(status, new Date().toISOString(), callId, ...from).changes === 1;
  }
  // The transfer was not answered (or its outcome is unknown): place the held urgent alert call now, once.
  async function releaseAlert(callId, reason) {
    if (!setTransfer(callId, 'alerting', ['pending', 'dialing'])) return transferRow(callId)?.status || 'no_transfer';
    const row = db.prepare('SELECT id, details FROM requests WHERE call_id = ?').get(callId);
    const assistantId = db.prepare('SELECT assistant_id FROM transfers WHERE call_id = ?').get(callId)?.assistant_id;
    const route = routes[assistantId];
    const outcome = row && route ? await settle(phoneAlerts(route, JSON.parse(row.details), true)) : 'not_configured';
    setTransfer(callId, 'alerted', ['alerting']);
    console.log(`transfer call=${callId} outcome=alert_${outcome} reason=${reason}`);
    return outcome;
  }
  // Was the caller handed to the owner? Asks Vapi for the call; any doubt counts as not connected.
  async function transferConnected(callId) {
    if (!env.VAPI_API_KEY) return false;
    try {
      const response = await send(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
        method: 'GET', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` } });
      if (!response.ok) return false;
      const call = await response.json();
      return call?.status === 'forwarding' || call?.endedReason === 'assistant-forwarded-call';
    } catch { return false; }
  }
  // Backstop: held alerts whose window passed without a connected transfer get their call.
  async function sweepTransfers(now = Date.now()) {
    if (!db) return [];
    const due = db.prepare("SELECT call_id FROM transfers WHERE status IN ('pending', 'dialing') AND due_at <= ?").all(now);
    const outcomes = [];
    for (const { call_id } of due) {
      if (await transferConnected(call_id)) { setTransfer(call_id, 'connected', ['pending', 'dialing']); outcomes.push('connected'); continue; }
      outcomes.push(await releaseAlert(call_id, 'timeout'));
    }
    return outcomes;
  }
  // transfer-destination-request: only a saved, urgent request with a transfer route is put through.
  function transferRequest(message) {
    const callId = conversationKey(message);
    const route = routeFor(message);
    const row = callId && db.prepare('SELECT details FROM requests WHERE call_id = ?').get(callId);
    if (!row) return { error: 'Not transferred: save the request with submit_service_request first.' };
    const details = JSON.parse(row.details);
    if (!canTransfer(route, details)) return { error: 'Not transferred: live transfer is only for urgent jobs on a line with a transfer number.' };
    // One attempt per call: the restarted window covers ringing, the owner's answer and the hand-over.
    db.prepare('INSERT OR IGNORE INTO transfers VALUES (?, ?, ?, ?, ?)').run(callId, assistantIdOf(message), 'pending', 0, new Date().toISOString());
    if (!setTransfer(callId, 'dialing', ['pending'])) return { error: 'Not transferred: the owner was already tried on this call.' };
    db.prepare('UPDATE transfers SET due_at = ? WHERE call_id = ?').run(Date.now() + fallbackMs, callId);
    return { destination: transferDestination(route, details) };
  }
  async function addNote(callId, args, route) {
    const row = db.prepare('SELECT id, details, result FROM requests WHERE call_id = ?').get(callId);
    if (!row) return failure('No saved request yet; save the request first');
    const note = typeof args?.note === 'string' ? args.note.trim() : '';
    if (!note || note.length > 1000) return failure('Missing or invalid note');
    const details = JSON.parse(row.details);
    details.notes = [...(details.notes || []), note].slice(-20);
    db.prepare('UPDATE requests SET details = ? WHERE call_id = ?').run(JSON.stringify(details), callId);
    return { saved: true, request_id: row.id, note_added: true, office_alert: await alert(route, details, row.id, 'note') };
  }
  // An email given after the request was saved: only accepted once spelled back and confirmed, then the confirmation goes out.
  async function addEmail(callId, args, route) {
    const row = db.prepare('SELECT id, details FROM requests WHERE call_id = ?').get(callId);
    if (!row) return failure('No saved request yet; save the request first');
    if (args?.confirmed_after_spelling_back !== true) return failure('Not added: spell the email back letter by letter and get a clear yes first.');
    const email = typeof args?.email === 'string' ? args.email.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return failure('Invalid email');
    const details = JSON.parse(row.details);
    details.email = email;
    db.prepare('UPDATE requests SET details = ? WHERE call_id = ?').run(JSON.stringify(details), callId);
    const caller_email = details.is_test ? 'suppressed_test' : await receipt(email, details, row.id, 'caller', route);
    return { saved: true, request_id: row.id, email_added: true, caller_email };
  }
  // The live transfer came back unanswered: the held urgent alert call goes out now.
  async function noAnswer(callId) {
    const status = transferRow(callId)?.status;
    if (!status) return failure('No live transfer was tried on this call.');
    if (status === 'alerted' || status === 'alerting') return { saved: true, owner_alert: 'already_sent' };
    if (status === 'connected') return failure('The caller was already connected to the owner.');
    return { saved: true, owner_alert: await releaseAlert(callId, 'no_answer') };
  }
  // Safety net: a phone call that ended without a saved request still reaches the office.
  async function hangup(callId, message, route) {
    if (db.prepare('SELECT 1 FROM requests WHERE call_id = ?').get(callId)) return 'already_saved';
    const callerId = callerNumberOf(message);
    if (!callerId) return 'no_caller_id';
    if (!(Number(message.durationSeconds) >= 10)) return 'too_short';
    const summary = String(message.analysis?.summary || message.summary || '').trim().slice(0, 1000);
    // A caller who said "test call" is a test; never alert a client about it.
    const said = `${message.artifact?.transcript || message.transcript || ''} ${summary}`;
    const details = { name: 'Unknown caller', address: '', issue: summary ? `Hung up before finishing. Summary: ${summary}` : 'Hung up before giving details',
      is_test: /test call/i.test(said), callback_phone: '', caller_id: callerId, email: '', notes: [] };
    const id = randomUUID();
    const result = { saved: true, retryable: false, request_id: id, source: 'hangup', caller_email: 'not_requested', anchorline_email: 'not_requested' };
    classify(details, callId, message);
    const inserted = insert(true, callId, id, details, result, assistantIdOf(message));
    if (!inserted.changes) return 'already_saved';
    result.office_alert = await alert(route, details, id, 'hangup');
    db.prepare('UPDATE requests SET result = ? WHERE call_id = ?').run(JSON.stringify(result), callId);
    return `hangup_request_created alert=${result.office_alert}`;
  }
  async function submit(callId, args, message = {}) {
    const old = db.prepare('SELECT result FROM requests WHERE call_id = ?').get(callId);
    if (old) return { ...JSON.parse(old.result), duplicate: true };
    if (!args || typeof args !== 'object' || Array.isArray(args)) return failure('Invalid parameters');
    const details = {};
    for (const field of ['name', 'address', 'issue']) {
      if (typeof args[field] !== 'string' || !args[field].trim() || args[field].length > 4000) return failure(`Missing or invalid ${field}`);
      details[field] = args[field].trim();
    }
    if (typeof args.is_test !== 'boolean') return failure('is_test must be boolean');
    details.is_test = args.is_test;
    if (args.callback_phone != null && (typeof args.callback_phone !== 'string' || args.callback_phone.length > 100)) return failure('Invalid callback phone');
    details.callback_phone = args.callback_phone || '';
    if (args.preferred_time != null && (typeof args.preferred_time !== 'string' || args.preferred_time.length > 200)) return failure('Invalid preferred time');
    details.preferred_time = (args.preferred_time || '').trim();
    // Job context from the receptionist's follow-up questions, so the office can plan the day.
    for (const field of ['job_type', 'job_size', 'job_details']) {
      if (args[field] != null && (typeof args[field] !== 'string' || args[field].length > 500)) return failure(`Invalid ${field}`);
      details[field] = (args[field] || '').trim();
    }
    // Skipping the email question is only allowed for emergencies.
    if (args.email_status === 'skipped_emergency' && !/^\s*URGENT\b/i.test(details.issue))
      return failure('Not saved: this is not an urgent job, so ask the caller for their email first, then save again.');
    details.caller_id = callerNumberOf(message);
    details.notes = [];
    details.email = '';
    if (args.email_confirmed === true) {
      if (typeof args.email !== 'string' || args.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) return failure('Invalid confirmed email');
      details.email = args.email;
    }
    classify(details, callId, message);
    const id = randomUUID();
    const result = { saved: true, retryable: false, request_id: id,
      caller_email: details.email ? 'pending' : 'not_requested',
      anchorline_email: env.OFFICE_EMAIL ? 'pending' : 'not_requested' };
    // Commit before any network operation. One request per Vapi call survives retries/restarts.
    insert(false, callId, id, details, result, assistantIdOf(message));
    // Urgent job with an owner's cell on the route: offer a live transfer and hold the spoken alert call for its outcome.
    const transfer = canTransfer(routeFor(message), details);
    if (transfer) {
      db.prepare('INSERT OR IGNORE INTO transfers VALUES (?, ?, ?, ?, ?)').run(callId, assistantIdOf(message), 'pending', Date.now() + fallbackMs, new Date().toISOString());
      result.live_transfer = 'available';
    }
    const officeAlert = alert(routeFor(message), details, id, 'new', transfer);
    if (details.is_test) {
      result.caller_email = details.email ? 'suppressed_test' : 'not_requested';
      result.anchorline_email = env.OFFICE_EMAIL ? 'suppressed_test' : 'not_requested';
    } else {
      [result.caller_email, result.anchorline_email] = await Promise.all([
        receipt(details.email, details, id, 'caller', routeFor(message)), receipt(env.OFFICE_EMAIL, details, id, 'office')
      ]);
    }
    result.office_alert = await officeAlert;
    db.prepare('UPDATE requests SET result = ? WHERE call_id = ?').run(JSON.stringify(result), callId);
    return result;
  }
  function once(callId, args, message) {
    if (inflight.has(callId)) return inflight.get(callId);
    const task = submit(callId, args, message).finally(() => inflight.delete(callId));
    inflight.set(callId, task);
    return task;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && ['/', '/healthz', '/readyz'].includes(path)) {
      const ready = !!db && key.length >= 32;
      try { if (db) db.prepare('SELECT 1').get(); }
      catch { return reply(503, { status: 'unhealthy', ready: false }); }
      return reply(path === '/readyz' && !ready ? 503 : 200, {
        status: 'ok', service: 'Anchorline Vapi Receptionist', version: '1.6.0', ready,
        storage_configured: !!db, webhook_auth_configured: key.length >= 32,
        email_configured: !!(env.RESEND_API_KEY && env.EMAIL_FROM && env.OFFICE_EMAIL),
        sms_configured: !!(env.TELNYX_API_KEY && env.TELNYX_FROM), call_alerts_configured: !!(env.VAPI_API_KEY && env.ALERT_CALL_FROM_ID), alert_routes: Object.keys(routes).length, booking_routes: booking.routeCount,
        transfer_routes: Object.values(routes).filter(r => isE164(r?.transfer)).length
      });
    }
    // Read-only counts for ops checks (e.g. "is any test data left before go-live?"). Counts and IDs only, never caller details.
    if (path === '/admin/requests/summary') {
      if (req.method !== 'GET') return reply(405, { error: 'GET required' });
      if (!db || key.length < 32) return reply(503, { error: 'Not configured' });
      if (!authorized(req)) return reply(401, { error: 'Unauthorized' });
      const groups = db.prepare(`SELECT COALESCE(assistant_id, 'unknown') AS assistant_id, is_test, COUNT(*) AS n,
        MIN(created_at) AS first, MAX(created_at) AS last FROM requests GROUP BY 1, 2 ORDER BY 1, 2`).all();
      const total = groups.reduce((sum, g) => sum + g.n, 0);
      const test = groups.filter(g => g.is_test).reduce((sum, g) => sum + g.n, 0);
      return reply(200, { total, live: total - test, test, by_assistant: groups.map(g => ({ ...g, is_test: !!g.is_test })) });
    }
    if (path !== '/vapi/webhook') return reply(404, { error: 'Not found' });
    if (req.method !== 'POST') return reply(405, { error: 'POST required' });
    if (!db || key.length < 32) return reply(503, failure('Webhook not configured'));
    if (!authorized(req)) return reply(401, { error: 'Unauthorized' });
    try {
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        // End-of-call reports carry the transcript, so allow more than tool calls need.
        if (length > 2097152) { reply(413, { error: 'Payload too large' }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return reply(400, { error: 'Invalid JSON' }); }
      const message = body?.message;
      if (message?.type === 'end-of-call-report') {
        const callId = conversationKey(message);
        const outcome = callId && message.call ? await hangup(callId, message, routeFor(message)) : 'no_call';
        // A held urgent alert is settled when the call ends: handed to the owner, or the alert call goes out now.
        let transfer = '';
        if (callId && ['pending', 'dialing'].includes(transferRow(callId)?.status)) {
          const forwarded = (message.endedReason ?? message.call?.endedReason) === 'assistant-forwarded-call';
          transfer = forwarded && setTransfer(callId, 'connected', ['pending', 'dialing']) ? ' transfer=connected' : ` transfer=alert_${await releaseAlert(callId, 'call_ended')}`;
        }
        // Operational log only: outcome and IDs, never caller details.
        console.log(`end-of-call-report call=${callId} assistant=${assistantIdOf(message)} outcome=${outcome}${transfer}`);
        return reply(200, {});
      }
      if (message?.type === 'transfer-destination-request') {
        const answer = transferRequest(message);
        console.log(`transfer-destination-request call=${conversationKey(message)} assistant=${assistantIdOf(message)} outcome=${answer.error ? 'refused' : 'dialing'}`);
        return reply(200, answer);
      }
      if (message?.type === 'transfer-update') {
        console.log(`transfer-update call=${conversationKey(message)} destination=${message.destination?.type || 'unknown'}`);
        return reply(200, {});
      }
      if (message?.type !== 'tool-calls') return reply(200, {});
      const calls = message.toolCallList ?? (Array.isArray(message.toolWithToolCallList)
        ? message.toolWithToolCallList.map(item => ({ ...item?.toolCall, name: item?.name })) : null);
      if (!Array.isArray(calls) || !calls.length || calls.length > 10 || calls.some(t => !t || typeof t.id !== 'string' || !t.id || t.id.length > 200)) return reply(400, { error: 'Invalid tool calls' });
      const results = [];
      for (const tool of calls) {
        let result;
        const callId = conversationKey(message);
        const name = tool.function?.name || tool.name;
        if (!callId) result = failure('Missing Vapi call, chat or session ID');
        else if (name === 'add_request_note') {
          try {
            let args = tool.function?.arguments ?? tool.parameters;
            if (typeof args === 'string') args = JSON.parse(args);
            result = await addNote(callId, args, routeFor(message));
          } catch { result = failure('Unable to add note'); }
        }
        else if (name === 'add_customer_email') {
          try {
            let args = tool.function?.arguments ?? tool.parameters;
            if (typeof args === 'string') args = JSON.parse(args);
            result = await addEmail(callId, args, routeFor(message));
          } catch { result = failure('Unable to add email'); }
        }
        else if (name === 'transfer_no_answer') {
          try { result = await noAnswer(callId); } catch { result = failure('Unable to alert the owner'); }
        }
        else if (booking.names.includes(name)) {
          try {
            let args = tool.function?.arguments ?? tool.parameters;
            if (typeof args === 'string') args = JSON.parse(args);
            result = await booking.handle(name, { callId, assistantId: assistantIdOf(message), request: savedRequest(callId) }, args);
          } catch { result = { booked: false, appointment_confirmed: false, status: 'error' }; }
        }
        else if (name !== 'submit_service_request') result = failure('Unknown tool');
        else {
          try {
            let args = tool.function?.arguments ?? tool.parameters;
            if (typeof args === 'string') args = JSON.parse(args);
            result = await once(callId, args, message);
          } catch {
            // Never claim a save failed if SQLite already persisted it before an error.
            const saved = db.prepare('SELECT result FROM requests WHERE call_id = ?').get(callId);
            result = saved ? JSON.parse(saved.result) : failure('Unable to process request');
          }
        }
        results.push({ toolCallId: tool.id, result: JSON.stringify(result) });
      }
      reply(200, { results });
    } catch { if (!res.headersSent) reply(500, { error: 'Request failed' }); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  // Held urgent alerts are checked every few seconds, and again after a restart (rows live in SQLite).
  const sweeper = db ? setInterval(() => sweepTransfers().catch(() => {}), 5000) : null;
  sweeper?.unref();
  server.sweepTransfers = sweepTransfers;
  server.on('close', () => { clearInterval(sweeper); db?.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Anchorline receptionist listening'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
