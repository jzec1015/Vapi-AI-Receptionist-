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

export function createApp(env = process.env, send = fetch) {
  const dataDir = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR;
  const key = env.VAPI_WEBHOOK_SECRET || '';
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
  async function receipt(to, details, id, recipient) {
    if (!to) return 'not_requested';
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return 'needs_review';
    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${id}-${recipient}` },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: 'Anchorline service request received',
          text: `Request reference: ${id}\n\nName: ${details.name}\nAddress: ${details.address}\nIssue: ${details.issue}\nCallback: ${details.callback_phone || 'Not provided'}\n\nThis records a request only. It does not confirm an appointment, dispatch, transfer, or callback.` })
      });
      return response.ok ? 'accepted' : 'needs_review';
    } catch { return 'needs_review'; }
  }
  async function submit(callId, args) {
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
    if (details.is_test) {
      result.caller_email = details.email ? 'suppressed_test' : 'not_requested';
      result.anchorline_email = env.OFFICE_EMAIL ? 'suppressed_test' : 'not_requested';
    } else {
      [result.caller_email, result.anchorline_email] = await Promise.all([
        receipt(details.email, details, id, 'caller'), receipt(env.OFFICE_EMAIL, details, id, 'office')
      ]);
    }
    db.prepare('UPDATE requests SET result = ? WHERE call_id = ?').run(JSON.stringify(result), callId);
    return result;
  }
  function once(callId, args) {
    if (inflight.has(callId)) return inflight.get(callId);
    const task = submit(callId, args).finally(() => inflight.delete(callId));
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
        status: 'ok', service: 'Anchorline Vapi Receptionist', version: '1.0.1', ready,
        storage_configured: !!db, webhook_auth_configured: key.length >= 32,
        email_configured: !!(env.RESEND_API_KEY && env.EMAIL_FROM && env.OFFICE_EMAIL)
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
        if (length > 262144) { reply(413, { error: 'Payload too large' }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return reply(400, { error: 'Invalid JSON' }); }
      const message = body?.message;
      if (message?.type !== 'tool-calls') return reply(200, {});
      const calls = message.toolCallList ?? (Array.isArray(message.toolWithToolCallList)
        ? message.toolWithToolCallList.map(item => ({ ...item?.toolCall, name: item?.name })) : null);
      if (!Array.isArray(calls) || !calls.length || calls.length > 10 || calls.some(t => !t || typeof t.id !== 'string' || !t.id || t.id.length > 200)) return reply(400, { error: 'Invalid tool calls' });
      const results = [];
      for (const tool of calls) {
        let result;
        const callId = conversationKey(message);
        if (!callId) result = failure('Missing Vapi call, chat or session ID');
        else if ((tool.function?.name || tool.name) !== 'submit_service_request') result = failure('Unknown tool');
        else {
          try {
            let args = tool.function?.arguments ?? tool.parameters;
            if (typeof args === 'string') args = JSON.parse(args);
            result = await once(callId, args);
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
