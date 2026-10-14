import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

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

// US numbers read as (615) 555-0142; anything else is shown as given.
export function formatPhone(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : String(value || '');
}

// Plain-text office alert, kept short enough for two SMS segments.
export function alertText(route, details, kind = 'new') {
  const urgent = /^\s*URGENT\b/i.test(details.issue);
  const head = kind === 'note' ? 'Update' : kind === 'hangup' ? 'Caller hung up' : urgent ? 'URGENT call' : 'New call';
  const phone = details.callback_phone ? formatPhone(details.callback_phone) : (details.caller_id ? `${formatPhone(details.caller_id)} (caller ID)` : 'no number given');
  const issue = details.issue.replace(/^\s*URGENT\s*-\s*/i, '');
  const lines = [`${urgent || kind === 'hangup' ? '🚨 ' : ''}${head}${route.business ? ` - ${route.business}` : ''}`, `${details.name} · ${phone}`];
  if (details.address) lines.push(details.address);
  lines.push(kind === 'note' ? `Note: ${details.notes.at(-1)}` : issue);
  if (kind === 'new' && details.preferred_time) lines.push(`Wants: ${details.preferred_time}`);
  return lines.join('\n').slice(0, 300);
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

export function createApp(env = process.env, send = fetch) {
  const dataDir = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR;
  const key = env.VAPI_WEBHOOK_SECRET || '';
  // ALERT_ROUTES: {"<assistantId>": {"business": "...", "sms": ["+1..."], "email": ["..."], "alertTests": false}}
  let routes = {};
  try { routes = JSON.parse(env.ALERT_ROUTES || '{}') || {}; } catch { routes = {}; }
  const routeFor = message => routes[assistantIdOf(message)] || null;
  let db;
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(join(dataDir, 'requests.sqlite'));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS requests (
        call_id TEXT PRIMARY KEY, id TEXT NOT NULL, created_at TEXT NOT NULL,
        details TEXT NOT NULL, result TEXT NOT NULL
      );`);
  }
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
  // Office alerts for one client route. Returns a status string; never throws.
  async function alert(route, details, id, kind) {
    if (!route || (details.is_test && !route.alertTests)) return details.is_test ? 'suppressed_test' : 'not_configured';
    const text = alertText(route, details, kind);
    const jobs = [];
    if (env.TELNYX_API_KEY && env.TELNYX_FROM) {
      for (const to of route.sms || []) jobs.push(send('https://api.telnyx.com/v2/messages', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.TELNYX_FROM, to, text }) }));
    }
    if (env.RESEND_API_KEY && env.EMAIL_FROM && (route.email || []).length) {
      jobs.push(send('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${id}-alert-${kind}-${details.notes.length}` },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: route.email, subject: text.split('\n')[0], text: `${text}\n\nRequest reference: ${id}` }) }));
    }
    if (!jobs.length) return 'not_configured';
    const settled = await Promise.allSettled(jobs);
    return settled.every(s => s.status === 'fulfilled' && s.value.ok) ? 'sent' : 'needs_review';
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
    const inserted = db.prepare('INSERT OR IGNORE INTO requests VALUES (?, ?, ?, ?, ?)').run(callId, id, new Date().toISOString(), JSON.stringify(details), JSON.stringify(result));
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
    details.caller_id = callerNumberOf(message);
    details.notes = [];
    details.email = '';
    if (args.email_confirmed === true) {
      if (typeof args.email !== 'string' || args.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email)) return failure('Invalid confirmed email');
      details.email = args.email;
    }
    const id = randomUUID();
    const result = { saved: true, retryable: false, request_id: id,
      caller_email: details.email ? 'pending' : 'not_requested',
      anchorline_email: env.OFFICE_EMAIL ? 'pending' : 'not_requested' };
    // Commit before any network operation. One request per Vapi call survives retries/restarts.
    db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)').run(callId, id, new Date().toISOString(), JSON.stringify(details), JSON.stringify(result));
    const officeAlert = alert(routeFor(message), details, id, 'new');
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
        status: 'ok', service: 'Anchorline Vapi Receptionist', version: '1.2.0', ready,
        storage_configured: !!db, webhook_auth_configured: key.length >= 32,
        email_configured: !!(env.RESEND_API_KEY && env.EMAIL_FROM && env.OFFICE_EMAIL),
        sms_configured: !!(env.TELNYX_API_KEY && env.TELNYX_FROM), alert_routes: Object.keys(routes).length
      });
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
        // Operational log only: outcome and IDs, never caller details.
        console.log(`end-of-call-report call=${callId} assistant=${assistantIdOf(message)} outcome=${outcome}`);
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
  server.on('close', () => db?.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Anchorline receptionist listening'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
