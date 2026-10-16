import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createBooking } from './booking.mjs';
import { createTrials, migrateClients, inService } from './trial.mjs';
import { ruleTags, callerWords, outOfArea, shouldRing, URGENT_TAGS, tagLabel } from './rules.mjs';

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
const jsonList = value => { try { const list = JSON.parse(value || '[]'); return Array.isArray(list) ? list.filter(v => typeof v === 'string' && v) : []; } catch { return []; } };
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

// Lock-screen email subjects: what, where, who to call, e.g. "URGENT – burst pipe – 1412 Dickerson Pike – (615) 555-0142".
// A house number that speech recognition clearly garbled: over 6 digits, or 3+ separate digit groups before the
// street ("2 42 4 0 Elm Street"). Deliberately narrow; "24240 Elm" and "100 200 Main" pass.
export const garbledHouseNumber = address => {
  const lead = String(address || '').trim().match(/^(\d+(?:[\s-]+\d+)*)(?=\s|,|$)/);
  if (!lead) return false;
  const groups = lead[1].split(/[\s-]+/);
  return groups.some(g => g.length > 6) || (groups.length >= 3 && groups.every(g => g.length <= 2));
};

// At most 90 characters; the phone number is never cut, the address keeps its first part (street), the issue gets the rest.
const SEP = ' \u2013 ';
const clip = (text, n) => {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (text.length <= n) return text;
  if (n < 4) return '';
  const cut = text.slice(0, n - 1);
  const words = /\s/.test(text[n - 1]) ? cut : cut.replace(/\s+\S*$/, '');
  return `${(words || cut).replace(/[\s,.;:-]+$/, '')}\u2026`;
};
export function subjectLine(head, topic, address, phone, max = 90) {
  const room = max - head.length - phone.length - SEP.length * 3;
  const street = String(address || '').split(',')[0];
  let place = clip(street, 28);
  let what = clip(topic, room - place.length);
  if (what.length < 12 && place) { place = clip(street, room - 12); what = clip(topic, room - place.length); }
  return [head, what, place, phone].filter(Boolean).join(SEP).slice(0, max);
}
export function alertSubject(details, kind = 'new') {
  const urgent = /^\s*URGENT\b/i.test(details.issue);
  const phone = formatPhone(details.callback_phone || details.caller_id) || 'no number given';
  if (kind === 'hangup') return `${urgent ? 'URGENT: c' : 'C'}aller hung up${details.greeting_hangup ? ' during greeting' : ''}${SEP}${phone}${SEP}call them back`;
  if (kind === 'unanswered') return subjectLine('UNANSWERED URGENT', details.issue.replace(/^\s*URGENT\s*-\s*/i, ''), details.address, phone);
  const head = kind === 'note' ? (urgent ? 'URGENT update' : 'Update') : urgent ? 'URGENT' : 'New job';
  return subjectLine(head, kind === 'note' ? details.notes.at(-1) : details.issue.replace(/^\s*URGENT\s*-\s*/i, ''), details.address, phone);
}

// Did a person hear an alert call? Judged from Vapi's endedReason, the only outcome Vapi reports. Everything else
// (customer-did-not-answer, customer-busy, voicemail, silence-timed-out, exceeded-max-duration, failed to connect,
// errors, unknown) counts as not answered: a needless backup call is cheap, an unseen urgent job is not.
// customer-ended-call counts only after 15 s (long enough to hear the job); a voicemail that hangs up by itself after
// 15 s is the known gap (Vapi cannot tell it from a person without voicemail detection).
export function answeredCall(endedReason, seconds) {
  return ['assistant-ended-call', 'assistant-said-end-call-phrase'].includes(endedReason) || (endedReason === 'customer-ended-call' && Number(seconds) >= 15);
}

// Calendar days for the daily digest are America/Chicago days (DST-safe, from Intl).
const TZ = 'America/Chicago';
const zoned = ms => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
function zonedMidnight(y, m, d) {
  const wall = Date.UTC(y, m - 1, d);
  let t = wall;
  for (let i = 0; i < 2; i++) { const p = zoned(t); t = wall - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t); }
  return t;
}
// Yesterday (Chicago) as an ISO window for created_at comparisons, plus the local hour now.
export function digestWindow(now = Date.now()) {
  const p = zoned(now);
  const y = new Date(Date.UTC(p.year, p.month - 1, p.day - 1));
  return { hour: p.hour, day: y.toISOString().slice(0, 10), label: y.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }),
    start: new Date(zonedMidnight(y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate())).toISOString(), end: new Date(zonedMidnight(p.year, p.month, p.day)).toISOString() };
}

// Plain-text office alert. GSM-7 only (no emoji, no smart quotes) so a full alert is at most
// 3 SMS segments; one non-GSM character would switch the whole text to UCS-2 (70 chars/segment).
// Carrier rules: the sender brand (Anchorline AI) is named and every text carries an opt-out line,
// matching the registered 10DLC campaign samples.
const gsm = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"')
  .replace(/[\u2013\u2014\u00B7\u2022]/g, '-').replace(/\u2026/g, '...').replace(/[^\n\x20-\x7E]/g, '');
// channel 'email': same lines, but no SMS opt-out footer, no 280-character cut and no GSM-7 stripping.
export function alertText(route, details, kind = 'new', channel = 'sms') {
  const urgent = /^\s*URGENT\b/i.test(details.issue);
  const head = kind === 'note' ? (urgent ? 'URGENT update' : 'Update') : kind === 'hangup' ? (urgent ? 'URGENT: caller hung up' : 'Caller hung up') : urgent ? 'URGENT call' : 'New call';
  const phone = details.callback_phone ? formatPhone(details.callback_phone) : (details.caller_id ? `${formatPhone(details.caller_id)} (caller ID)` : 'no number given');
  const issue = details.issue.replace(/^\s*URGENT\s*-\s*/i, '');
  const lines = [`Anchorline AI: ${head}${route.business ? ` - ${route.business}` : ''}`, `${details.name} - ${phone}`];
  if (details.address) lines.push(details.address);
  lines.push(kind === 'note' ? `Note: ${details.notes.at(-1)}` : issue);
  if (kind === 'new' && (details.job_type || details.job_size)) lines.push(`Job: ${[details.job_type, details.job_size].filter(Boolean).join(' - ')}`);
  if (kind === 'new' && details.job_details) lines.push(`Details: ${details.job_details}`);
  if (kind === 'new' && details.preferred_time) lines.push(`Wants: ${details.preferred_time}`);
  // Flags from the plumber rules (rules.mjs): renter, warranty company, Spanish speaker, out of area...
  const flags = (details.rule_tags || []).filter(t => !URGENT_TAGS.has(t)).map(tagLabel);
  if (kind !== 'note' && flags.length) lines.push(`Flags: ${flags.join('; ')}`);
  // Email only: the call recording (from Vapi's end-of-call report) near the top, when the server has it.
  if (channel === 'email' && details.recording_url) lines.splice(1, 0, `Recording: ${details.recording_url}`);
  if (channel === 'email') return lines.join('\n');
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
// stage: primary, backup (the primary ring went unanswered) or retry (the primary, once more).
export function alertCall(route, details, phoneNumberId, to, missedTransfer = false, stage = 'primary') {
  const issue = details.issue.replace(/^\s*URGENT\s*-\s*/i, '');
  const phone = details.callback_phone ? formatPhone(details.callback_phone) : details.caller_id ? formatPhone(details.caller_id) : 'no number given';
  const job = `${details.name}, at ${details.address || 'no address given'}. ${issue}. Callback number: ${phone}.`;
  const missed = (missedTransfer ? ' I tried to put them through to you live but couldn\'t reach you, so please call them back.' : '') +
    (stage === 'backup' ? ' I couldn\'t reach the main number, so I\'m calling you as the backup.' : stage === 'retry' ? ' This is my second try; I couldn\'t reach you a few minutes ago.' : '');
  return {
    phoneNumberId, customer: { number: to },
    assistant: {
      name: 'Urgent job alert', maxDurationSeconds: 90, endCallFunctionEnabled: true, firstMessageMode: 'assistant-speaks-first',
      firstMessage: `Hi, this is an urgent job alert for ${route.business}. ${job}${missed} It's also in your email. Want me to repeat that?`,
      voice: { provider: '11labs', voiceId: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_turbo_v2_5' },
      model: { provider: 'openai', model: 'gpt-4.1', maxTokens: 120, messages: [{ role: 'system', content:
        `You just delivered this urgent job alert for ${route.business}: ${job} If asked, repeat it slowly, especially the callback number. ` +
        'You cannot do anything else. When they say thanks, no, or goodbye, say a short goodbye and end the call. ' +
        // Ending the call is read as "a person heard it" (answeredCall), so a voicemail must never be ended by the assistant.
        'If you only hear a voicemail greeting, a beep or a recording, never end the call yourself; just wait.' }] }
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
  // "backup": "+1..." (E.164) is rung when the urgent alert call is not answered; the "call" numbers are then rung once more
  // about 5 minutes after the first ring, and "email" gets an "UNANSWERED URGENT – ..." email (see escalate).
  // "digest": false turns off the 7am (America/Chicago) daily digest to "email"; "digest": ["..."] adds recipients to it.
  let routes = {};
  try { routes = JSON.parse(env.ALERT_ROUTES || '{}') || {}; } catch { routes = {}; }
  // The route for an assistant: an ALERT_ROUTES entry wins; otherwise an active trial client row (SMS stays off
  // until the 10DLC campaign covers trial clients). Every route lookup goes through here.
  const routeOf = assistantId => routes[assistantId] || clientRoute(assistantId);
  const routeFor = message => routeOf(assistantIdOf(message));
  // Urgent escalation timing. Alert calls last at most 90 s (maxDurationSeconds), so the first ring is judged 150 s after it
  // was placed; a ring Vapi still cannot report after 10 minutes counts as not answered. The retry is ~5 minutes after the first ring.
  const CHECK_MS = 150000, RECHECK_MS = 30000, RETRY_MS = 300000, GIVE_UP_MS = 600000;
  const fallbackMs = Math.max(0, Number(env.TRANSFER_FALLBACK_SECONDS ?? 75) || 0) * 1000;
  const canTransfer = (route, details) => !!route && isE164(route.transfer) && /^\s*URGENT\b/i.test(details.issue) && (!details.is_test || !!route.alertTests) &&
    shouldRing(details.rule_tags, route);
  let db;
  let trialsEnabled = false;
  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(join(dataDir, 'requests.sqlite'));
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS requests (
        call_id TEXT PRIMARY KEY, id TEXT NOT NULL, created_at TEXT NOT NULL,
        details TEXT NOT NULL, result TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transfers (
        call_id TEXT PRIMARY KEY, assistant_id TEXT, status TEXT NOT NULL, due_at INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bookings (call_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, result TEXT NOT NULL);
      -- v1.8: urgent alert calls (one row per job, stage and number, claimed before Vapi is called), the escalation of
      -- each urgent job, every customer call Emma answered, and sent daily digests. New tables only: v1.7.1 ignores them.
      CREATE TABLE IF NOT EXISTS alert_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, stage TEXT NOT NULL, to_number TEXT NOT NULL, placed_at INTEGER NOT NULL,
        vapi_call_id TEXT, outcome TEXT, ended_reason TEXT, UNIQUE (call_id, stage, to_number)
      );
      CREATE INDEX IF NOT EXISTS alert_calls_vapi ON alert_calls (vapi_call_id);
      CREATE TABLE IF NOT EXISTS escalations (
        call_id TEXT PRIMARY KEY, status TEXT NOT NULL, check_at INTEGER NOT NULL, emailed TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS call_log (call_id TEXT PRIMARY KEY, assistant_id TEXT, ended_at TEXT NOT NULL, seconds REAL, is_test INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS call_log_day ON call_log (assistant_id, ended_at);
      CREATE TABLE IF NOT EXISTS digests (
        assistant_id TEXT NOT NULL, day TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, sent_at TEXT,
        PRIMARY KEY (assistant_id, day)
      );`);
    // v1.7: trial clients live in their own new tables (clients, client_calls; see migrateClients in trial.mjs).
    // v1.6.0 and v1.5.0 never read them, so a rollback ignores them and a later roll-forward finds them as they were.
    // A failed trial migration switches trials off (healthz trials_enabled: false) but never stops the server.
    try { migrateClients(db); trialsEnabled = true; } catch (error) { console.warn(`trial migration failed, trials disabled: ${error?.message || 'error'}`); }
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
  const clientRow = assistantId => (db && trialsEnabled && assistantId ? db.prepare('SELECT * FROM clients WHERE assistant_id = ?').get(assistantId) : null) || null;
  // Active trials, and ended trials in their grace period (Emma keeps answering and emailing the office).
  function clientRoute(assistantId) {
    const row = clientRow(assistantId);
    if (!inService(row)) return null;
    // The signup form tells owners urgent jobs ring their cell, so an empty alert_call list falls back to owner_cell.
    const call = jsonList(row.alert_call);
    return { business: row.business, sms: [], email: jsonList(row.office_emails), call: call.length ? call : [row.owner_cell].filter(Boolean),
      transfer: row.transfer || undefined, service_area: row.service_area || undefined };
  }
  // Trial minutes: one usage row per call (Vapi may resend a report), added to the client's total in one transaction.
  // The first report that takes minutes_used to the cap emails Anchorline once. Calls are never refused.
  async function trackMinutes(callId, message) {
    const client = clientRow(assistantIdOf(message));
    if (!client) return '';
    // Test calls (TEST_* lists, or the owner calling from their own cell) still use minutes but are left out of results emails.
    const callerId = callerNumberOf(message);
    const isTest = !!testReason(env, { callId, assistantId: client.assistant_id, callerId }) || (!!callerId && digitsOf(callerId) === digitsOf(client.owner_cell));
    const seconds = Number(message.durationSeconds ?? message.call?.durationSeconds) || Number(message.durationMinutes) * 60 || 0;
    const minutes = Math.max(0, seconds) / 60;
    db.exec('BEGIN IMMEDIATE');
    let crossed = false;
    try {
      const fresh = db.prepare('INSERT OR IGNORE INTO client_calls (call_id, client_id, minutes, created_at, is_test) VALUES (?, ?, ?, ?, ?)')
        .run(callId, client.id, minutes, new Date().toISOString(), isTest ? 1 : 0).changes === 1;
      if (fresh) db.prepare('UPDATE clients SET minutes_used = minutes_used + ? WHERE id = ?').run(minutes, client.id);
      crossed = db.prepare('UPDATE clients SET cap_alerted_at = ? WHERE id = ? AND cap_alerted_at IS NULL AND minutes_used >= minute_cap')
        .run(new Date().toISOString(), client.id).changes === 1;
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const used = db.prepare('SELECT minutes_used, minute_cap FROM clients WHERE id = ?').get(client.id);
    const capAlert = crossed ? ` cap_alert=${await officeNotice(`Trial over minute cap: ${client.business}`,
      `${client.business} has used ${used.minutes_used.toFixed(1)} of ${used.minute_cap} trial minutes. Emma keeps answering.\n\n` +
      `Client: ${client.id}\nOwner: ${client.owner_name} ${client.owner_cell}\nAssistant: ${client.assistant_id}\nTrial ends: ${client.trial_ends_at || 'not set'}`,
      `${client.id}-minute-cap`)}` : '';
    // Twice the cap ends the trial at once (no grace period).
    const usageEnd = await trials.usageCheck(client.id);
    return ` minutes=${used.minutes_used.toFixed(1)}/${used.minute_cap}${capAlert}${usageEnd}`;
  }
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
  // Calls already told once that the house number looked garbled; the second save goes through so no caller is lost.
  const addressWarned = new Set();
  const readBackWarned = new Set();
  // Self-serve trials: /trial/*, /admin/trials, assistant-request answers and the hourly trial sweep.
  const trials = createTrials({ env, send, db: trialsEnabled ? db : null, key, officeNotice, testReason, routes });
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
  // Operational email to Anchorline (OFFICE_EMAIL), same Resend path as the request receipts.
  async function officeNotice(subject, text, idempotencyKey) {
    if (!env.OFFICE_EMAIL) return 'not_requested';
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return 'needs_review';
    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [env.OFFICE_EMAIL], subject, text }) });
      return response.ok ? 'accepted' : 'needs_review';
    } catch { return 'needs_review'; }
  }
  // Email to a route's own addresses (Resend). Returns accepted, needs_review or not_configured; never throws.
  async function mail(to, subject, text, idempotencyKey) {
    if (!to?.length || !env.RESEND_API_KEY || !env.EMAIL_FROM) return 'not_configured';
    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }) });
      return response.ok ? 'accepted' : 'needs_review';
    } catch { return 'needs_review'; }
  }
  const last4 = number => String(number).slice(-4);
  // Spoken alert calls for one stage of an urgent job (primary, backup, retry). Each job+stage+number is claimed in
  // SQLite before Vapi is called, so a restart or an overlapping sweep never rings anyone twice. The Vapi call id is
  // kept so the sweep can ask Vapi how the call ended. Returns Responses for settle().
  function placeCalls(callId, route, details, stage, numbers, missedTransfer = false) {
    if (!env.VAPI_API_KEY || !env.ALERT_CALL_FROM_ID) return [];
    return numbers.map(async to => {
      if (db.prepare('INSERT OR IGNORE INTO alert_calls (call_id, stage, to_number, placed_at) VALUES (?, ?, ?, ?)').run(callId, stage, to, Date.now()).changes !== 1) return { ok: true };
      let response, vapiId = null;
      try {
        response = await send('https://api.vapi.ai/call', {
          method: 'POST', signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${env.VAPI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(alertCall(route, details, env.ALERT_CALL_FROM_ID, to, missedTransfer, stage)) });
        if (response.ok) try { const id = (await response.clone().json())?.id; if (typeof id === 'string' && id.length <= 200) vapiId = id; } catch {}
      } catch {}
      // Refused or unreachable: that ring is already known to be unanswered.
      if (response?.ok) db.prepare('UPDATE alert_calls SET vapi_call_id = ? WHERE call_id = ? AND stage = ? AND to_number = ?').run(vapiId, callId, stage, to);
      else db.prepare("UPDATE alert_calls SET outcome = 'unanswered', ended_reason = 'not_placed' WHERE call_id = ? AND stage = ? AND to_number = ?").run(callId, stage, to);
      console.log(`alert-call call=${callId} stage=${stage} to=..${last4(to)} placed=${response?.ok ? 'yes' : 'no'} http=${response?.status || 'error'} vapi=${vapiId || 'none'}`);
      if (!response) throw new Error('alert call failed');
      return response;
    });
  }
  // The first spoken alert for an urgent job, with its escalation row (checked by sweepEscalations). When Vapi refused
  // every ring, the check is due at once: nobody is being rung.
  function ring(callId, route, details, missedTransfer = false) {
    const numbers = (route.call || []).filter(Boolean);
    if (!env.VAPI_API_KEY || !env.ALERT_CALL_FROM_ID || !numbers.length) return [];
    db.prepare('INSERT OR IGNORE INTO escalations (call_id, status, check_at, updated_at) VALUES (?, ?, ?, ?)').run(callId, 'ringing', Date.now() + CHECK_MS, new Date().toISOString());
    return placeCalls(callId, route, details, 'primary', numbers, missedTransfer).map(job => job.finally(() => db.prepare(`UPDATE escalations SET check_at = ?
      WHERE call_id = ? AND status = 'ringing' AND NOT EXISTS (SELECT 1 FROM alert_calls WHERE call_id = ? AND stage = 'primary' AND (outcome IS NULL OR outcome = 'answered'))`)
      .run(Date.now(), callId, callId)));
  }
  // Office alerts for one client route. Returns a status string; never throws.
  // holdCall: a live transfer will be tried first, so the spoken alert call waits for its outcome.
  async function alert(route, details, id, kind, holdCall = false, callId = '') {
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
      const emailText = alertText(route, details, kind, 'email');
      jobs.push(send('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${id}-alert-${kind}-${details.notes.length}` },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: route.email, subject: alertSubject(details, kind), text: `${emailText}\n\nRequest reference: ${id}` }) }));
    }
    const urgent = /^\s*URGENT\b/i.test(details.issue);
    // After hours only the shop's wake emergencies ring the owner (rules.mjs shouldRing); the urgent email still goes now.
    if (kind === 'new' && urgent && !holdCall && callId && shouldRing(details.rule_tags, route)) jobs.push(...ring(callId, route, details));
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
    const route = routeOf(assistantId);
    const outcome = row && route ? await settle(ring(callId, route, JSON.parse(row.details), true)) : 'not_configured';
    setTransfer(callId, 'alerted', ['alerting']);
    console.log(`transfer call=${callId} outcome=alert_${outcome} reason=${reason}`);
    return outcome;
  }
  // Was the caller handed to the owner? Asks Vapi for the call; any doubt counts as not connected.
  async function transferConnected(callId) {
    const call = await vapiCall(callId);
    return call?.status === 'forwarding' || call?.endedReason === 'assistant-forwarded-call';
  }
  // GET a Vapi call; null on any error.
  async function vapiCall(id) {
    if (!env.VAPI_API_KEY) return null;
    try {
      const response = await send(`https://api.vapi.ai/call/${encodeURIComponent(id)}`, {
        method: 'GET', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${env.VAPI_API_KEY}` } });
      return response.ok ? await response.json() : null;
    } catch { return null; }
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
  // ---------- urgent escalation ----------
  // How an alert call ended. Vapi does not send this server the alert call's end-of-call report unless the org or
  // phone number points its Server URL here, so the sweep asks Vapi (GET /call/<id>) and also takes a report when one
  // arrives (alertReport). Returns answered, unanswered, or null while it is not known yet.
  function recordOutcome(row, endedReason, seconds) {
    const outcome = answeredCall(endedReason, seconds) ? 'answered' : 'unanswered';
    if (db.prepare('UPDATE alert_calls SET outcome = ?, ended_reason = ? WHERE id = ? AND outcome IS NULL').run(outcome, endedReason, row.id).changes)
      console.log(`alert-outcome call=${row.call_id} stage=${row.stage} to=..${last4(row.to_number)} outcome=${outcome} reason=${endedReason}`);
    return db.prepare('SELECT outcome FROM alert_calls WHERE id = ?').get(row.id).outcome;
  }
  async function resolveCall(row, now) {
    if (row.outcome) return row.outcome;
    const age = now - row.placed_at;
    if (!row.vapi_call_id) return age >= 30000 ? recordOutcome(row, 'no_call_id', 0) : null;
    const call = await vapiCall(row.vapi_call_id);
    if (call?.status === 'ended') return recordOutcome(row, String(call.endedReason || 'unknown'), (Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000);
    return age >= GIVE_UP_MS ? recordOutcome(row, call ? `still_${call.status || 'unknown'}` : 'unknown', 0) : null;
  }
  // An alert call's own end-of-call report: record the outcome; it is not a customer call (no hang-up lead, no minutes).
  function alertReport(callId, message) {
    const row = db.prepare('SELECT * FROM alert_calls WHERE vapi_call_id = ?').get(callId);
    if (!row) return null;
    return recordOutcome(row, String(message.endedReason ?? message.call?.endedReason ?? 'unknown'), Number(message.durationSeconds ?? message.call?.durationSeconds));
  }
  const setEscalation = (callId, status, from) => db.prepare(`UPDATE escalations SET status = ?, updated_at = ? WHERE call_id = ? AND status IN (${from.map(() => '?').join(', ')})`)
    .run(status, new Date().toISOString(), callId, ...from).changes === 1;
  // The owner's "nobody picked up" email, to the route's emails and Anchorline (OFFICE_EMAIL). Kept on the escalation
  // row; later sweeps resend until accepted (same Idempotency-Key, so never twice).
  async function unansweredEmail(callId, route, request, details, now) {
    const rings = db.prepare("SELECT to_number, ended_reason FROM alert_calls WHERE call_id = ? AND stage = 'primary'").all(callId);
    const tried = rings.map(r => `${formatPhone(r.to_number)} (${String(r.ended_reason || 'no answer').replace(/[-_]/g, ' ')})`).join(', ') || 'no number';
    const retryAt = db.prepare('SELECT check_at FROM escalations WHERE call_id = ?').get(callId)?.check_at || now;
    const next = [isE164(route.backup) ? `Emma is calling the backup number ${formatPhone(route.backup)} now.` : '',
      `Emma will ring ${(route.call || []).map(formatPhone).join(' and ') || 'you'} once more in about ${Math.max(1, Math.round((retryAt - now) / 60000))} minutes.`].filter(Boolean).join(' ');
    const subject = alertSubject(details, 'unanswered');
    const text = `Emma's urgent alert call was not answered: ${tried}.\n${next}\nPlease call the customer back now.\n\n${alertText(route, details, 'new', 'email')}\n\nRequest reference: ${request.id}`;
    const [client] = await Promise.all([mail(route.email, subject, text, `${request.id}-unanswered`),
      officeNotice(`${subject.slice(0, 70)} (${route.business || 'no business'})`, text, `${request.id}-unanswered-office`)]);
    db.prepare('UPDATE escalations SET emailed = ? WHERE call_id = ?').run(client, callId);
    return client;
  }
  // One step of an urgent job's escalation, run by the sweep when check_at passes:
  //   ringing    first ring judged: answered ends it; unanswered emails the office, rings the backup, schedules the retry
  //   escalated  retry time: rings the "call" numbers once more, unless the backup answered
  //   retried    records how the backup and retry rings ended (for the daily digest), then ends
  // Every move is a status claim (UPDATE ... WHERE status = ...), so overlapping sweeps and restarts never repeat a step.
  async function escalate(callId, status, emailed, now) {
    const request = db.prepare('SELECT id, details, assistant_id FROM requests WHERE call_id = ?').get(callId);
    const route = request && routeOf(request.assistant_id);
    const details = request && JSON.parse(request.details);
    const finish = final => { if (setEscalation(callId, final, [status])) console.log(`escalation call=${callId} outcome=${final}`); return final; };
    if (!route) return finish('no_route');
    if (details.is_test && !route.alertTests) return finish('suppressed_test');
    const rows = (...stages) => db.prepare(`SELECT * FROM alert_calls WHERE call_id = ? AND stage IN (${stages.map(() => '?').join(', ')})`).all(callId, ...stages);
    const outcomes = async list => { const out = []; for (const row of list) out.push(await resolveCall(row, now)); return out; };
    const later = () => { db.prepare('UPDATE escalations SET check_at = ? WHERE call_id = ? AND status = ?').run(now + RECHECK_MS, callId, status); return 'waiting'; };
    // An earlier "nobody picked up" email that did not go through is tried again on every step.
    const resend = async () => (status !== 'ringing' && emailed === 'needs_review' ? ` email=${await unansweredEmail(callId, route, request, details, now)}` : '');
    if (status === 'ringing') {
      const primary = await outcomes(rows('primary'));
      if (primary.includes('answered')) return finish('answered');
      if (primary.includes(null)) return later();
      if (!setEscalation(callId, 'escalated', ['ringing'])) return 'busy';
      const first = Math.min(...rows('primary').map(r => r.placed_at));
      db.prepare('UPDATE escalations SET check_at = ? WHERE call_id = ?').run(Math.max(now, (Number.isFinite(first) ? first : now) + RETRY_MS), callId);
      const backup = isE164(route.backup) ? [route.backup] : [];
      const [email, rang] = await Promise.all([unansweredEmail(callId, route, request, details, now), settle(placeCalls(callId, route, details, 'backup', backup))]);
      console.log(`escalation call=${callId} outcome=escalated email=${email} backup=${backup.length ? rang : 'none'}`);
      return 'escalated';
    }
    if (status === 'escalated') {
      if ((await outcomes(rows('backup'))).includes('answered')) return finish('answered') + await resend();
      if (!setEscalation(callId, 'retried', ['escalated'])) return 'busy';
      db.prepare('UPDATE escalations SET check_at = ? WHERE call_id = ?').run(now + CHECK_MS, callId);
      const rang = await settle(placeCalls(callId, route, details, 'retry', (route.call || []).filter(Boolean)));
      console.log(`escalation call=${callId} outcome=retried retry=${rang}`);
      return 'retried' + await resend();
    }
    const rest = await outcomes(rows('backup', 'retry'));
    if (rest.includes('answered')) return finish('answered') + await resend();
    if (rest.includes(null)) return later() + await resend();
    return finish('unanswered') + await resend();
  }
  async function sweepEscalations(now = Date.now()) {
    if (!db) return [];
    const due = db.prepare("SELECT call_id, status, emailed FROM escalations WHERE status IN ('ringing', 'escalated', 'retried') AND check_at <= ?").all(now);
    const done = [];
    for (const { call_id, status, emailed } of due) {
      try { done.push(await escalate(call_id, status, emailed, now)); } catch { console.warn(`escalation call=${call_id} failed`); done.push('error'); }
    }
    return done;
  }
  // ---------- daily digest ----------
  // How an urgent job's alert went, in the owner's words.
  function ringSummary(callId) {
    if (transferRow(callId)?.status === 'connected') return 'put through to you live';
    const rings = db.prepare('SELECT stage, outcome FROM alert_calls WHERE call_id = ?').all(callId);
    if (!rings.length) return 'no alert call placed';
    const answered = rings.find(r => r.outcome === 'answered');
    if (answered) return `alert call answered${answered.stage === 'backup' ? ' by the backup number' : answered.stage === 'retry' ? ' on the second try' : ''}`;
    return rings.some(r => !r.outcome) ? 'alert call outcome not known yet' : 'alert calls NOT answered';
  }
  // Yesterday's live numbers for one assistant. Calls are every customer call (call_log) plus any saved request, so a
  // line without end-of-call reports still counts its jobs as calls.
  function digestStats(assistantId, start, end) {
    const calls = db.prepare(`SELECT COUNT(*) AS n FROM (
        SELECT call_id FROM call_log c WHERE assistant_id = ? AND is_test = 0 AND ended_at >= ? AND ended_at < ?
          AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.call_id = c.call_id AND r.is_test = 1)
        UNION SELECT call_id FROM requests r WHERE assistant_id = ? AND is_test = 0 AND created_at >= ? AND created_at < ?
          AND NOT EXISTS (SELECT 1 FROM call_log c WHERE c.call_id = r.call_id AND c.is_test = 1))`).get(assistantId, start, end, assistantId, start, end).n;
    const rows = db.prepare(`SELECT call_id, details, result FROM requests r WHERE assistant_id = ? AND is_test = 0 AND created_at >= ? AND created_at < ?
      AND NOT EXISTS (SELECT 1 FROM call_log c WHERE c.call_id = r.call_id AND c.is_test = 1) ORDER BY created_at`).all(assistantId, start, end)
      .map(r => ({ call_id: r.call_id, details: JSON.parse(r.details), hangup: JSON.parse(r.result).source === 'hangup' }));
    const jobs = rows.filter(r => !r.hangup);
    const urgent = jobs.filter(r => /^\s*URGENT\b/i.test(r.details.issue)).map(r => ({ ...r, ring: ringSummary(r.call_id) }));
    return { calls, jobs: jobs.length, urgent, hangups: rows.filter(r => r.hangup) };
  }
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function digestEmail(route, label, stats) {
    const { calls, jobs, urgent, hangups } = stats;
    const subject = calls ? `Emma yesterday${SEP}${count(calls, 'call')}, ${count(jobs, 'job')} saved${urgent.length ? `, ${urgent.length} urgent` : ''}` +
      `${hangups.length ? `, ${count(hangups.length, 'hang-up')}` : ''}` : 'Emma answered 0 forwarded calls yesterday \u2014 she\'s on and working';
    const lines = [`${route.business || 'Your line'}${SEP}${label}`, '', `Calls Emma answered: ${calls}`, `Jobs saved: ${jobs}`, `Urgent jobs: ${urgent.length}`,
      ...urgent.map(u => `- ${u.details.name}${SEP}${String(u.details.address || 'no address').split(',')[0]}${SEP}${u.ring}`),
      `Hang-ups: ${hangups.length}`, ...hangups.map(h => `- ${formatPhone(h.details.caller_id)}${h.details.greeting_hangup ? ' (hung up during greeting)' : ''}${SEP}call them back`), '',
      calls ? 'Every job was emailed to you as it came in.' : 'Emma answered 0 forwarded calls yesterday \u2014 she\'s on and working. ' +
        'If you expected calls, check that your shop line still forwards to Emma.', '', 'Anchorline AI'];
    return { subject, text: lines.join('\n') };
  }
  // 7am America/Chicago: yesterday's digest for each route (ALERT_ROUTES and trial clients in service), also on a zero-call
  // day. Once per route per day: claimed in SQLite (digests), up to 5 tries 15 minutes apart, same Idempotency-Key each try.
  // A server that is down at 7 sends it when it is back the same day. Off with "digest": false; skipped for test assistants.
  async function sendDigests(now = Date.now()) {
    if (!db || !env.RESEND_API_KEY || !env.EMAIL_FROM) return [];
    const { hour, day, label, start, end } = digestWindow(now);
    if (hour < 7) return [];
    const ids = new Set(Object.keys(routes));
    if (trialsEnabled) for (const { assistant_id } of db.prepare('SELECT assistant_id FROM clients WHERE assistant_id IS NOT NULL').all()) ids.add(assistant_id);
    const done = [];
    for (const assistantId of ids) {
      const route = routeOf(assistantId);
      if (!route || route.digest === false || (listOf(env.TEST_ASSISTANT_IDS).includes(assistantId) && !route.alertTests)) continue;
      const to = [...new Set([...(route.email || []), ...(Array.isArray(route.digest) ? route.digest : [])])].filter(v => typeof v === 'string' && v);
      if (!to.length) continue;
      db.prepare('INSERT OR IGNORE INTO digests (assistant_id, day) VALUES (?, ?)').run(assistantId, day);
      if (db.prepare('UPDATE digests SET attempts = attempts + 1, next_at = ? WHERE assistant_id = ? AND day = ? AND sent_at IS NULL AND attempts < 5 AND next_at <= ?')
        .run(now + 900000, assistantId, day, now).changes !== 1) continue;
      const { subject, text } = digestEmail(route, label, digestStats(assistantId, start, end));
      const status = await mail(to, subject, text, `digest-${assistantId}-${day}`);
      if (status === 'accepted') db.prepare('UPDATE digests SET sent_at = ? WHERE assistant_id = ? AND day = ?').run(new Date(now).toISOString(), assistantId, day);
      console.log(`digest assistant=${assistantId} day=${day} status=${status}`);
      done.push(`${assistantId}:${status}`);
    }
    return done;
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
    // "Now it's coming through the ceiling": a note with an emergency in it makes a routine job URGENT and rings as a new
    // urgent job would (rules.mjs), once.
    const noteTags = ruleTags(note).filter(t => !(details.rule_tags || []).includes(t));
    details.rule_tags = [...(details.rule_tags || []), ...noteTags];
    const upgrade = !/^\s*URGENT\b/i.test(details.issue) && !/^\s*not a job\b/i.test(details.issue) && noteTags.some(t => URGENT_TAGS.has(t));
    if (upgrade) { details.issue = `URGENT - ${details.issue}`; details.urgent_source = 'rules'; }
    db.prepare('UPDATE requests SET details = ? WHERE call_id = ?').run(JSON.stringify(details), callId);
    const office_alert = await alert(route, details, row.id, 'note');
    if (upgrade && route && (!details.is_test || route.alertTests) && shouldRing(details.rule_tags, route)) await settle(ring(callId, route, details));
    return { saved: true, request_id: row.id, note_added: true, office_alert, ...(upgrade ? { urgent: true } : {}) };
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
  // The call recording from an end-of-call report, when Vapi sent one (https only).
  const recordingOf = message => {
    const url = message.recordingUrl || message.artifact?.recordingUrl || message.call?.artifact?.recordingUrl;
    return typeof url === 'string' && /^https:\/\/\S+$/.test(url) && url.length <= 1000 ? url : '';
  };
  // Safety net: a phone call that ended without a saved request still reaches the office.
  // A caller who hangs up within the greeting (under 10 s, no details) is a lead too: "call them back". That one is sent
  // only on a line with an alert route, and once per caller number per 30 minutes (a redial that hangs up again is the same lead).
  async function hangup(callId, message, route) {
    if (db.prepare('SELECT 1 FROM requests WHERE call_id = ?').get(callId)) return 'already_saved';
    if (message.call?.type === 'outboundPhoneCall') return 'outbound';
    const callerId = callerNumberOf(message);
    if (!callerId) return 'no_caller_id';
    const greeting = !(Number(message.durationSeconds) >= 10);
    if (greeting && !route) return 'too_short';
    if (greeting && db.prepare(`SELECT 1 FROM requests WHERE assistant_id IS ? AND created_at >= ? AND json_extract(details, '$.caller_id') = ?`)
      .get(assistantIdOf(message), new Date(Date.now() - 1800000).toISOString(), callerId)) return 'repeat_caller';
    const summary = String(message.analysis?.summary || message.summary || '').trim().slice(0, 1000);
    // A caller who said "test call" is a test; never alert a client about it.
    const said = `${message.artifact?.transcript || message.transcript || ''} ${summary}`;
    const issue = greeting ? 'Hung up during the greeting, before giving any details' : summary ? `Hung up before finishing. Summary: ${summary}` : 'Hung up before giving details';
    // A gas caller is told to hang up and leave: the summary's emergency words still put "URGENT" on the hang-up alert.
    const tags = ruleTags(said);
    const details = { name: 'Unknown caller', address: '', issue: tags.some(t => URGENT_TAGS.has(t)) ? `URGENT - ${issue}` : issue, rule_tags: tags,
      is_test: /test call/i.test(said), callback_phone: '', caller_id: callerId, email: '', notes: [],
      ...(greeting ? { greeting_hangup: true } : {}), ...(recordingOf(message) ? { recording_url: recordingOf(message) } : {}) };
    const id = randomUUID();
    const result = { saved: true, retryable: false, request_id: id, source: 'hangup', caller_email: 'not_requested', anchorline_email: 'not_requested' };
    classify(details, callId, message);
    const inserted = insert(true, callId, id, details, result, assistantIdOf(message));
    if (!inserted.changes) return 'already_saved';
    result.office_alert = await alert(route, details, id, 'hangup');
    db.prepare('UPDATE requests SET result = ? WHERE call_id = ?').run(JSON.stringify(result), callId);
    return `${greeting ? 'greeting_hangup' : 'hangup'}_request_created alert=${result.office_alert}`;
  }
  // After a saved call ends: keep Vapi's recording link on the request (used by the "nobody picked up" email).
  function noteRecording(callId, message) {
    const url = recordingOf(message);
    if (url) db.prepare(`UPDATE requests SET details = json_set(details, '$.recording_url', ?) WHERE call_id = ? AND json_valid(details)
      AND json_extract(details, '$.recording_url') IS NULL`).run(url, callId);
  }
  // Every customer call Emma answered, for the daily digest. Test calls are kept but flagged (same rules as requests,
  // plus a trial owner calling from their own cell).
  function logCall(callId, message) {
    if (message.call?.type === 'outboundPhoneCall') return;
    const assistantId = assistantIdOf(message) || '';
    const callerId = callerNumberOf(message);
    const owner = clientRow(assistantId)?.owner_cell;
    const test = !!testReason(env, { callId, assistantId, callerId }) || /test call/i.test(`${message.artifact?.transcript || message.transcript || ''}`) ||
      (!!callerId && !!owner && digitsOf(callerId) === digitsOf(owner)) || !!db.prepare('SELECT 1 FROM requests WHERE call_id = ? AND is_test = 1').get(callId);
    const seconds = Number(message.durationSeconds ?? message.call?.durationSeconds);
    db.prepare('INSERT OR IGNORE INTO call_log VALUES (?, ?, ?, ?, ?)').run(callId, assistantId || null, new Date().toISOString(), Number.isFinite(seconds) ? seconds : null, test ? 1 : 0);
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
    if (garbledHouseNumber(details.address) && !addressWarned.has(callId)) {
      if (addressWarned.size > 10000) addressWarned.clear();
      addressWarned.add(callId);
      return failure('Not saved: the house number sounds garbled. Say "Sorry, I want to make sure I have the house number right. Could you say just the number again?", read it back digit by digit, then save again.');
    }
    if (args.callback_phone != null && (typeof args.callback_phone !== 'string' || args.callback_phone.length > 100)) return failure('Invalid callback phone');
    details.callback_phone = args.callback_phone || '';
    if (args.preferred_time != null && (typeof args.preferred_time !== 'string' || args.preferred_time.length > 200)) return failure('Invalid preferred time');
    details.preferred_time = (args.preferred_time || '').trim();
    // Job context from the receptionist's follow-up questions, so the office can plan the day.
    for (const field of ['job_type', 'job_size', 'job_details']) {
      if (args[field] != null && (typeof args[field] !== 'string' || args[field].length > 500)) return failure(`Invalid ${field}`);
      details[field] = (args[field] || '').trim();
    }
    // A number given but not read back (callback_read_back false) goes back once with the read-back line; the second try
    // saves with a flag on the alert, so no caller is lost. Older tool definitions without the field are not checked.
    const ownNumber = !!details.callback_phone && digitsOf(details.callback_phone) === digitsOf(callerNumberOf(message));
    if (details.callback_phone && args.callback_read_back === false && !ownNumber && !readBackWarned.has(callId)) {
      if (readBackWarned.size > 10000) readBackWarned.clear();
      readBackWarned.add(callId);
      return failure('Not saved: read the callback number back first ("So that\'s six one five, ...?"), wait for a yes, then save again with callback_read_back true.');
    }
    // Plumber rules (rules.mjs): what the caller said plus Emma's summary. An emergency trigger makes the job URGENT even
    // when Emma left the prefix off; flags (renter, warranty company, Spanish...) go on the owner's alert.
    const tags = ruleTags(`${details.issue} ${details.job_type} ${details.job_details} ${callerWords(message)}`);
    if (details.callback_phone && args.callback_read_back === false && !ownNumber) tags.push('callback_unconfirmed');
    const route = routeFor(message);
    if (route?.service_area && /\w/.test(details.address) && !/^not given$/i.test(details.address) && outOfArea(details.address, route.service_area)) tags.push('out_of_area');
    details.rule_tags = tags;
    // A sales pitch or job enquiry that mentions "flood" is still not a job.
    const notAJob = /^\s*not a job\b/i.test(details.issue) || tags.includes('sales_call') || tags.includes('job_seeker');
    if (!notAJob && !/^\s*URGENT\b/i.test(details.issue) && tags.some(t => URGENT_TAGS.has(t))) {
      details.issue = `URGENT - ${details.issue}`;
      details.urgent_source = 'rules';
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
    const officeAlert = alert(routeFor(message), details, id, 'new', transfer, callId);
    if (details.is_test) {
      result.caller_email = details.email ? 'suppressed_test' : 'not_requested';
      result.anchorline_email = env.OFFICE_EMAIL ? 'suppressed_test' : 'not_requested';
    } else {
      [result.caller_email, result.anchorline_email] = await Promise.all([
        receipt(details.email, details, id, 'caller', routeFor(message)), receipt(env.OFFICE_EMAIL, details, id, 'office')
      ]);
    }
    result.office_alert = await officeAlert;
    if (details.urgent_source === 'rules') {
      result.urgent = true;
      result.say = 'Saved as URGENT from what the caller described. Give the matching safety line if you have not, skip the time question, and tell them the team has it marked urgent.';
    }
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
        status: 'ok', service: 'Anchorline Vapi Receptionist', version: '1.8.0', ready, trials_enabled: trialsEnabled,
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
    if (path.startsWith('/trial/') || path === '/admin/trials' || path.startsWith('/admin/trials/')) {
      try { if (await trials.handle(req, res)) return; } catch (error) {
        console.warn(`trial route failed: ${error?.name || 'Error'}`);
        if (!res.headersSent) return reply(500, { error: 'Request failed' });
        return res.end();
      }
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
        const ringOutcome = callId ? alertReport(callId, message) : null;
        if (ringOutcome) { console.log(`end-of-call-report alert-call=${callId} outcome=${ringOutcome}`); return reply(200, {}); }
        const outcome = callId && message.call ? await hangup(callId, message, routeFor(message)) : 'no_call';
        if (callId && message.call) try { noteRecording(callId, message); logCall(callId, message); } catch { console.warn('call log failed'); }
        // A held urgent alert is settled when the call ends: handed to the owner, or the alert call goes out now.
        let transfer = '';
        if (callId && ['pending', 'dialing'].includes(transferRow(callId)?.status)) {
          const forwarded = (message.endedReason ?? message.call?.endedReason) === 'assistant-forwarded-call';
          transfer = forwarded && setTransfer(callId, 'connected', ['pending', 'dialing']) ? ' transfer=connected' : ` transfer=alert_${await releaseAlert(callId, 'call_ended')}`;
        }
        // Trial clients: count the call's minutes. A failure here never changes the reply to Vapi.
        let usage = '';
        if (callId && message.call) try { usage = await trackMinutes(callId, message); } catch { usage = ' minutes=error'; }
        if (callId && message.call) try { usage += trials.callEnded(callId, message, callerNumberOf(message)); } catch { usage += ' forwarding=error'; }
        // Operational log only: outcome and IDs, never caller details.
        console.log(`end-of-call-report call=${callId} assistant=${assistantIdOf(message)} outcome=${outcome}${transfer}${usage}`);
        return reply(200, {});
      }
      if (message?.type === 'transfer-destination-request') {
        const answer = transferRequest(message);
        console.log(`transfer-destination-request call=${conversationKey(message)} assistant=${assistantIdOf(message)} outcome=${answer.error ? 'refused' : 'dialing'}`);
        return reply(200, answer);
      }
      // A trial number with no assistant (trial ended): ring the shop's own line. Unknown numbers get {} (fallbackDestination).
      if (message?.type === 'assistant-request') {
        let answer = {};
        try { answer = trials.assistantRequest(message); } catch { answer = {}; }
        console.log(`assistant-request outcome=${answer.destination ? 'shop' : answer.assistantId ? 'assistant' : 'fallback'}`);
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
  // Held urgent alerts, urgent escalations and the 7am digest are checked every few seconds, and again after a restart
  // (all state lives in SQLite). One pass at a time, so a slow Vapi or Resend never stacks passes.
  let sweeping = false;
  const sweepAll = async () => {
    if (sweeping) return;
    sweeping = true;
    try { await sweepTransfers().catch(() => {}); await sweepEscalations().catch(() => {}); await sendDigests().catch(() => console.warn('digest failed')); }
    finally { sweeping = false; }
  };
  const sweeper = db ? setInterval(sweepAll, 5000) : null;
  sweeper?.unref();
  // Trials: hourly (results emails, trial end, stuck provisioning), and once a minute after startup.
  const trialSweep = () => trials.sweep().catch(() => console.warn('trial sweep failed'));
  const trialSweeper = trialsEnabled ? setInterval(trialSweep, 3600000) : null;
  const trialStart = trialsEnabled ? setTimeout(trialSweep, 60000) : null;
  trialSweeper?.unref(); trialStart?.unref();
  server.sweepTransfers = sweepTransfers;
  server.sweepEscalations = sweepEscalations;
  server.sendDigests = sendDigests;
  server.trials = trials;
  server.on('close', () => { clearInterval(sweeper); clearInterval(trialSweeper); clearTimeout(trialStart); db?.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Anchorline receptionist listening'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
