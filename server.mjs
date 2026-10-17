import http from 'node:http';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createBooking } from './booking.mjs';
import { createTrials, migrateClients, inService } from './trial.mjs';

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
const sha = value => createHash('sha256').update(String(value)).digest('hex');
// Log fields come from the webhook body: keep them to one short token.
const logSafe = value => String(value ?? 'none').replace(/[^\w.:-]/g, '_').slice(0, 120) || 'none';
const toolOutcome = r => r?.duplicate ? 'duplicate' : r && Object.values(r).includes('needs_review') ? 'needs_review' : r?.saved === false ? (r.retryable ? 'retryable_error' : 'refused')
  : r?.booked === false ? `not_booked_${logSafe(r.status)}` : r?.error ? 'refused' : 'ok';
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

// The spoken turns of a call from Vapi's end-of-call report: artifact.messages (role bot/user, text in message; or
// OpenAI-style assistant/user with content), else the artifact.transcript lines ("AI: ..." / "User: ...").
export function callTurns(message) {
  const list = message.artifact?.messages || message.messages;
  if (Array.isArray(list) && list.length) return list.filter(m => ['bot', 'assistant', 'user'].includes(m?.role))
    .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: String(m.message ?? m.content ?? '') }));
  const turns = [];
  for (const line of String(message.artifact?.transcript || message.transcript || '').split('\n')) {
    const tag = line.match(/^\s*(AI|Assistant|Bot|User|Customer):\s*(.*)$/i);
    if (tag) turns.push({ role: /^(user|customer)$/i.test(tag[1]) ? 'user' : 'assistant', text: tag[2] });
    else if (turns.length && line.trim()) turns.at(-1).text += ` ${line.trim()}`;
  }
  return turns;
}
// The arguments of every submit_service_request call Emma made, oldest first, from Vapi's end-of-call report. Vapi lists
// a tool call as {role: 'tool_calls', toolCalls: [{function: {name, arguments}}]} in artifact.messages and as
// {role: 'assistant', tool_calls: [...]} in artifact.messagesOpenAIFormatted; arguments is a JSON string (an object is
// read as is). The first of artifact.messages, artifact.messagesOpenAIFormatted and messages that holds any such call is
// used (they are the same call in different formats). Arguments that are not valid JSON count as {}.
function submitCalls(message) {
  const args = raw => {
    if (raw && typeof raw === 'object') return raw;
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
  };
  for (const list of [message.artifact?.messages, message.artifact?.messagesOpenAIFormatted, message.messages]) {
    if (!Array.isArray(list)) continue;
    const calls = list.filter(m => ['tool_calls', 'assistant'].includes(m?.role))
      .flatMap(m => [m.toolCalls, m.tool_calls].filter(Array.isArray).flat())
      .filter(call => call?.function?.name === 'submit_service_request').map(call => args(call.function.arguments));
    if (calls.length) return calls;
  }
  return [];
}
// The callback number the caller confirmed on a call that ended without a saved request, as 10 digits, or ''.
// It comes only from Emma's own submit_service_request call (a save that failed, or a call that dropped mid-save): the
// LAST such call decides, and only when its callback_read_back is exactly true and its callback_phone is a string of
// digits, spaces and ( ) + . - holding 10 digits that start 2-9 (an 11th, leading 1 is dropped). Emma's prompt lets her
// set callback_read_back true only after reading the number back and hearing a yes. The transcript is not read for this:
// with no such call it returns '' and the hang-up lead falls back to the caller ID.
export function confirmedCallback(message) {
  const last = submitCalls(message).at(-1);
  if (last?.callback_read_back !== true || typeof last.callback_phone !== 'string') return '';
  if (/[^\d\s()+.\-]/.test(last.callback_phone)) return '';
  const digits = digitsOf(last.callback_phone);
  return /^[2-9]\d{9}$/.test(digits) ? digits : '';
}
// The end of the call's transcript (at most max characters, cut at a line or word), so the office sees what the caller said.
export function transcriptExcerpt(message, max = 1500) {
  const text = (String(message.artifact?.transcript || message.transcript || '').trim() ||
    callTurns(message).map(t => `${t.role === 'user' ? 'User' : 'AI'}: ${t.text}`).join('\n')).trim();
  if (text.length <= max) return text;
  const tail = text.slice(-(max - 41)).replace(/^[\uDC00-\uDFFF]/, '');
  const start = tail.indexOf('\n') >= 0 && tail.indexOf('\n') < max / 3 ? tail.indexOf('\n') + 1 : tail.search(/\s/) + 1;
  const body = tail.slice(start).trim();
  // Cut inside a turn: keep that turn's speaker tag so the office knows who said it (40 characters are kept for it).
  const cut = text.length - tail.length + start;
  const speaker = /^\s*(AI|Assistant|Bot|User|Customer):/i.test(body) ? '' :
    (text.slice(0, cut).split('\n').reverse().map(line => line.match(/^\s*(AI|Assistant|Bot|User|Customer):/i)?.[1]).find(Boolean) || '');
  return `\u2026${speaker ? `${speaker}: \u2026` : ''}${body}`;
}
// The one urgent test: Emma saves an urgent job with an issue starting "URGENT - ".
export const isUrgent = issue => /^\s*URGENT\b/i.test(issue);
// Priority tier of a saved request, worked out when a job card or digest is written (never stored):
//   urgent      the issue starts with "URGENT"
//   high-value  not urgent, and job_size is "Big job (half day+)" (Emma's prompt files water heater replacement, main line
//               or sewer, repiping, multiple fixtures and water damage there), or Emma's job_type label names a big-ticket
//               job (HIGH_VALUE below). Only when job_type is empty are the issue and job_details read instead.
//   routine     everything else, including requests with no job details (hang-ups keep their own section)
// Big-ticket families (whole words, any case):
//   water heater  replace/install/new + water heater, or water heater ... replace/install/new one later in the sentence
//                 (not "water heater repair", "pilot light", "replace the faucet by the water heater"); also tankless
//   repipe        repipe, re-pipe, repiping
//   main/sewer    main/sewer line with replace, repair, backup, dig, excavate, collapsed, broken or cracked about the line
//                 and any sewer or sewage backup (not "sewer smell")
//                 (not "replace the shutoff valve on the main water line", not "sewer line camera inspection")
//   other         slab leak, remodel, new construction, whole-house re-plumb/repipe/filter/softener ("whole house" alone
//                 is how callers describe low pressure, so it does not count)
// One guard for every family: a match does not count when its clause (the comma-separated part of the sentence where the
// match ends, i.e. where the deciding word is) is NEGATED ("do not need", "not looking to", "isn't") or FINISHED work ("already", "last year", "had ... put in",
// "was replaced", a clause that starts "Replaced ...").
const HEATER = String.raw`(?:(?:the|a|an|my|our|their|his|her|old|existing|broken|leaking|leaky|gas|electric|\d+[- ]?gal(?:lon)?)\s+){0,4}water\s+heaters?\b`;
const LINE = String.raw`(?:main(?:\s+(?:water|sewer|drain))?|sewer)\s+(?:lines?|mains?|laterals?|pipes?)\b`;
const LINE_WORK = String.raw`(?:replace\w*|repair\w*|dig(?:s|ging)?|excavat\w*)`;
const BACKUP = String.raw`(?:back(?:ed|ing)?[\s-]?ups?|dig(?:s|ging)?|excavat\w*)`;
const HIGH_VALUE = [
  String.raw`\b(?:new|replace|replacing|replacement|install|installing)\s+${HEATER}`,
  String.raw`\bwater\s+heaters?\b.*?\b(?:replace|replaced|replacing|replacement|install|installed|installing|installation|new\s+(?:one|unit|tank|heater))\b`,
  String.raw`\btankless\b`,
  String.raw`\bre-?pip(?:e|es|ed|ing)\b`,
  String.raw`\b${LINE}.*?\b(?:${LINE_WORK}|${BACKUP}|collaps\w*|broken|cracked)\b`,
  String.raw`\b${LINE_WORK}\s+(?:(?:the|a|our|my|their|old|broken|cracked|whole)\s+){0,3}${LINE}`,
  String.raw`\b${BACKUP}\b.*?\b${LINE}`,
  String.raw`\bsewer\s+(?:replacement|repair)\b`,
  String.raw`\bsew(?:er|age)\s+back(?:ed|ing)?[\s-]?ups?\b`,
  String.raw`\bslab\s+leaks?\b`,
  String.raw`\bremodel(?:s|ed|ing)?\b`,
  String.raw`\bnew\s+construction\b`,
  String.raw`\bwhole[\s-]+(?:house|home)\s+(?:re-?plumb\w*|re-?pip\w*|plumbing|water\s+(?:filter|filtration|softener)\w*|filt\w*|softener\w*)`,
].map(source => new RegExp(source, 'gi'));
const NEGATED = /\b(?:not|never|without|don'?t|doesn'?t|didn'?t|isn'?t|aren'?t|wasn'?t|won'?t|no\s+(?:need|longer))\b|\bno\b(?!\s+(?:hot\s+)?(?:water|heat|pressure)\b)/i;
const FINISHED = /\b(?:already|last\s+(?:year|month|week|spring|summer|fall|winter)|(?:years?|months?|weeks?)\s+ago|(?:was|were|been|got|had)\s+(?:[\w'-]+\s+){0,4}?(?:replaced|installed|put\s+in|redone|repiped|remodeled))\b|^\s*(?:just\s+|recently\s+)?(?:replaced|installed|remodeled|repiped|redid)\b/i;
function namesBigJob(text) {
  for (const sentence of String(text || '').replace(/[‘’]/g, "'").split(/[.;!?\n]+/)) for (const pattern of HIGH_VALUE) {
    for (const m of sentence.matchAll(pattern)) {
      const end = m.index + m[0].length, next = sentence.indexOf(',', end);
      const clause = sentence.slice(sentence.lastIndexOf(',', end - 1) + 1, next < 0 ? undefined : next);
      if (!NEGATED.test(clause) && !FINISHED.test(clause)) return true;
    }
  }
  return false;
}
export function priorityTier(details = {}) {
  if (isUrgent(details.issue)) return 'urgent';
  if (/^\s*big job\b/i.test(details.job_size || '')) return 'high-value';
  const label = String(details.job_type || '').trim();
  return namesBigJob(label || [details.issue, details.job_details].filter(Boolean).join('\n')) ? 'high-value' : 'routine';
}
const TIER_LABEL = { urgent: 'Urgent', 'high-value': 'High-value job', routine: 'Routine' };
const TIER_ORDER = ['urgent', 'high-value', 'routine'];

// Lock-screen email subjects: what, where, who to call, e.g. "URGENT – burst pipe – 1412 Dickerson Pike – (615) 555-0142".
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
// How a hang-up lead's callback_phone was found, for the office alert and the digest. callback_source 'tool': Emma's own
// submit_service_request call with callback_read_back true (confirmedCallback). A hang-up lead stored before
// callback_source existed may carry a number an older transcript rule picked; it is never called confirmed.
export const hangupCallbackLabel = details => !details.callback_phone ? '' :
  details.callback_source === 'tool' ? 'confirmed on the call' : 'from the call transcript, not verified';
export function alertSubject(details, kind = 'new') {
  const urgent = isUrgent(details.issue);
  const phone = formatPhone(details.callback_phone || details.caller_id) || 'no number given';
  const unverified = details.callback_phone && details.callback_source !== 'tool' ? ' (not verified)' : '';
  if (kind === 'hangup') return `Caller hung up${details.greeting_hangup ? ' during greeting' : ''}${SEP}${phone}${unverified}${SEP}call them back`;
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
// delayedMin (an office retry of a job saved over an hour ago): "(delayed N min) " leads the first line, inside the cut.
export function alertText(route, details, kind = 'new', channel = 'sms', { delayedMin = 0 } = {}) {
  const urgent = isUrgent(details.issue);
  const head = kind === 'note' ? (urgent ? 'URGENT update' : 'Update') : kind === 'hangup' ? 'Caller hung up' : urgent ? 'URGENT call' : 'New call';
  const phone = details.callback_phone ? formatPhone(details.callback_phone) : (details.caller_id ? `${formatPhone(details.caller_id)} (caller ID)` : 'no number given');
  // A hang-up lead's callback number carries how it was found (hangupCallbackLabel), plus the caller ID when that differs.
  const callerIdToo = details.caller_id && digitsOf(details.caller_id) !== digitsOf(details.callback_phone) ? `; caller ID ${formatPhone(details.caller_id)}` : '';
  const also = kind === 'hangup' && details.callback_phone ? ` (${hangupCallbackLabel(details)}${callerIdToo})` : '';
  const issue = details.issue.replace(/^\s*URGENT\s*-\s*/i, '');
  const lines = [`Anchorline AI: ${delayedMin ? `(delayed ${delayedMin} min) ` : ''}${head}${route.business ? ` - ${route.business}` : ''}`, `${details.name} - ${phone}${also}`];
  if (details.address) lines.push(details.address);
  lines.push(kind === 'note' ? `Note: ${details.notes.at(-1)}` : issue);
  if (kind === 'new' && (details.job_type || details.job_size)) lines.push(`Job: ${[details.job_type, details.job_size].filter(Boolean).join(' - ')}`);
  if (kind === 'new' && details.job_details) lines.push(`Details: ${details.job_details}`);
  if (kind === 'new' && details.preferred_time) lines.push(`Wants: ${details.preferred_time}`);
  // Email only: the call recording (from Vapi's end-of-call report) near the top, when the server has it.
  if (channel === 'email' && details.recording_url) lines.splice(1, 0, `Recording: ${details.recording_url}`);
  // Email only: the priority tier right under the heading on every new job card (the SMS keeps all 280 characters for the job).
  if (channel === 'email' && kind === 'new') lines.splice(1, 0, `Priority: ${TIER_LABEL[priorityTier(details)]}`);
  if (channel === 'email') return lines.join('\n');
  return `${gsm(lines.join('\n')).slice(0, 280)}\nReply STOP to opt out`;
}

// The 7am digest email. stats: { calls, jobs: [{ details, ring? }] in save order, hangups: [{ details }] }. Jobs are listed
// by priority tier (urgent, high-value, routine), in save order within a tier; urgent jobs say how the alert call went.
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function digestEmail(route, label, stats) {
  const { calls, jobs, hangups } = stats;
  const byTier = Object.fromEntries(TIER_ORDER.map(tier => [tier, jobs.filter(j => priorityTier(j.details) === tier)]));
  const { urgent, 'high-value': high, routine } = byTier;
  const street = d => String(d.address || 'no address').split(',')[0];
  const what = d => clip(d.job_type || d.issue, 60);
  const subject = calls ? `Emma yesterday${SEP}${count(calls, 'call')}, ${count(jobs.length, 'job')} saved${urgent.length ? `, ${urgent.length} urgent` : ''}` +
    `${high.length ? `, ${high.length} high-value` : ''}${hangups.length ? `, ${count(hangups.length, 'hang-up')}` : ''}` : 'Emma answered 0 forwarded calls yesterday \u2014 she\'s on and working';
  const lines = [`${route.business || 'Your line'}${SEP}${label}`, '', `Calls Emma answered: ${calls}`, `Jobs saved: ${jobs.length}`, `Urgent jobs: ${urgent.length}`,
    ...urgent.map(u => `- Urgent${SEP}${u.details.name}${SEP}${street(u.details)}${SEP}${u.ring}`),
    `High-value jobs: ${high.length}`, ...high.map(h => `- High-value${SEP}${h.details.name}${SEP}${street(h.details)}${SEP}${what(h.details)}`),
    `Routine jobs: ${routine.length}`, ...routine.map(r => `- Routine${SEP}${r.details.name}${SEP}${street(r.details)}${SEP}${what(r.details)}`),
    `Hang-ups: ${hangups.length}`, ...hangups.map(h => `- ${formatPhone(h.details.callback_phone || h.details.caller_id)}${h.details.callback_phone ? ` (${hangupCallbackLabel(h.details)})` : ''}${h.details.greeting_hangup ? ' (hung up during greeting)' : ''}${SEP}call them back`), '',
    calls ? 'Every job was emailed to you as it came in.' : 'Emma answered 0 forwarded calls yesterday \u2014 she\'s on and working. ' +
      'If you expected calls, check that your shop line still forwards to Emma.', '', 'Anchorline AI'];
  return { subject, text: lines.join('\n') };
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

// CREATE TABLE IF NOT EXISTS leaves a table made by an earlier build of the retry-safety work as it was. Bring it up to
// date so an old table never breaks a save: outbox gained created_at (when the work was saved; the 1 h cut-off) and
// gave_up; tool_calls gained arg and assistant_id with a new primary key, which SQLite cannot add in place, so an old
// tool_calls table is kept aside as tool_calls_v0 (it only held dedupe claims) and a new one is made. One transaction.
export function upgradeRetryTables(db) {
  const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  const outbox = columns('outbox'), tools = columns('tool_calls');
  if (outbox.has('created_at') && outbox.has('gave_up') && tools.has('arg') && tools.has('assistant_id')) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!outbox.has('created_at')) db.exec(`ALTER TABLE outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      UPDATE outbox SET created_at = due_at - 30000 - 60000 * attempts WHERE created_at = 0;`);
    if (!outbox.has('gave_up')) db.exec('ALTER TABLE outbox ADD COLUMN gave_up TEXT');
    if (!tools.has('arg') || !tools.has('assistant_id')) db.exec(`DROP TABLE IF EXISTS tool_calls_v0; ALTER TABLE tool_calls RENAME TO tool_calls_v0;
      CREATE TABLE tool_calls (
        call_id TEXT NOT NULL, name TEXT NOT NULL, tool_call_id TEXT NOT NULL, args_key TEXT NOT NULL, arg TEXT NOT NULL, assistant_id TEXT,
        created_at TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (call_id, name, tool_call_id, args_key)
      );`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  console.warn(`retry tables upgraded: outbox created_at=${outbox.has('created_at') ? 'had' : 'added'} gave_up=${outbox.has('gave_up') ? 'had' : 'added'} tool_calls=${tools.has('arg') && tools.has('assistant_id') ? 'had' : 'rebuilt'}`);
  return true;
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
  const OFFICE_RETRY_MS = 60000, OFFICE_RETRIES = 5;
  const fallbackMs = Math.max(0, Number(env.TRANSFER_FALLBACK_SECONDS ?? 75) || 0) * 1000;
  const canTransfer = (route, details) => !!route && isE164(route.transfer) && isUrgent(details.issue) && (!details.is_test || !!route.alertTests);
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
      );
      -- v1.8.1: a request whose office alert reached nobody (every SMS, email and ring failed) is retried here every
      -- minute, 5 times, then Anchorline (OFFICE_EMAIL) is told. New table only: v1.8.0 ignores it.
      CREATE TABLE IF NOT EXISTS office_retries (
        call_id TEXT PRIMARY KEY, kind TEXT NOT NULL, email_key TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, done TEXT
      );
      CREATE INDEX IF NOT EXISTS office_retries_due ON office_retries (done, next_at);

      -- v1.8.1 (new tables only; v1.8.0 ignores them). tool_calls: one row per add_request_note / add_customer_email tool
      -- call (Vapi toolCall id + arguments), committed with the change before any network call. deliveries: one row per
      -- message and channel (SMS number, alert email, receipt address), so a retry re-sends only what did not go out.
      -- outbox: saved work whose sends have not finished; the sweep finishes it after a restart (gave_up: the outbox gave
      -- up on an office alert and is telling Anchorline). Older tables are brought up to date below (see upgradeRetryTables).
      CREATE TABLE IF NOT EXISTS tool_calls (
        call_id TEXT NOT NULL, name TEXT NOT NULL, tool_call_id TEXT NOT NULL, args_key TEXT NOT NULL, arg TEXT NOT NULL, assistant_id TEXT,
        created_at TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (call_id, name, tool_call_id, args_key)
      );
      CREATE TABLE IF NOT EXISTS deliveries (ref TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (ref, channel));
      CREATE TABLE IF NOT EXISTS outbox (
        ref TEXT PRIMARY KEY, kind TEXT NOT NULL, call_id TEXT NOT NULL, tool_call_id TEXT, args_key TEXT, created_at INTEGER NOT NULL,
        due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, gave_up TEXT
      );`);
    upgradeRetryTables(db);
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
      transfer: row.transfer || undefined };
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
  // Self-serve trials: /trial/*, /admin/trials, assistant-request answers and the hourly trial sweep.
  const trials = createTrials({ env, send, db: trialsEnabled ? db : null, key, officeNotice, testReason, routes });
  // Delivery ledger: a channel that went out is never sent again; one that failed, or was cut off by a restart (still
  // 'sending' with no send running in this process), is sent on the next try. A send of the same ref and channel that is
  // still running in this process is joined, never repeated: the submit, a Vapi retry, the outbox sweep and the office
  // retry (office_retries) all go through here with the same ref, so two of them never text one number twice.
  // Claimed synchronously before the network call.
  const sending = new Map();
  function sendOnce(ref, channel, fn) {
    if (!db) return fn();
    const slot = `${ref}\n${channel}`;
    if (sending.has(slot)) return sending.get(slot);
    if (db.prepare('SELECT status FROM deliveries WHERE ref = ? AND channel = ?').get(ref, channel)?.status === 'sent') return Promise.resolve({ ok: true });
    const mark = status => db.prepare(`INSERT INTO deliveries VALUES (?, ?, ?, ?)
      ON CONFLICT (ref, channel) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`).run(ref, channel, status, new Date().toISOString());
    mark('sending');
    let response;
    const task = (async () => { try { response = await fn(); return response; } finally { sending.delete(slot); mark(response?.ok ? 'sent' : 'failed'); } })();
    sending.set(slot, task);
    return task;
  }
  const addressChannel = to => `email:${sha(String(to).trim().toLowerCase()).slice(0, 32)}`;
  // Resend refuses one key reused with a new payload, so each caller address gets its own key; the first address on a
  // request keeps the v1.5 key (<id>-caller).
  const callerKey = (id, email) => {
    const first = db.prepare('SELECT channel FROM deliveries WHERE ref = ? LIMIT 1').get(`${id}-caller`)?.channel;
    return !first || first === addressChannel(email) ? `${id}-caller` : `${id}-caller-${sha(email.trim().toLowerCase()).slice(0, 32)}`;
  };
  async function receipt(to, details, id, recipient, route = null, idempotencyKey = `${id}-${recipient}`) {
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
      const response = await sendOnce(idempotencyKey, addressChannel(to), () => send('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ from: branded ? `${route.business} <${env.EMAIL_FROM}>` : env.EMAIL_FROM, to: [to], ...message,
          ...(branded && route.email?.length ? { reply_to: route.email } : {}) })
      }));
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
      // Already claimed (a retry, or an alert finished after a restart): report the stored ring, never ring again. A ring
      // Vapi refused (not_placed) reached nobody.
      if (db.prepare('INSERT OR IGNORE INTO alert_calls (call_id, stage, to_number, placed_at) VALUES (?, ?, ?, ?)').run(callId, stage, to, Date.now()).changes !== 1)
        return { ok: db.prepare('SELECT ended_reason FROM alert_calls WHERE call_id = ? AND stage = ? AND to_number = ?').get(callId, stage, to)?.ended_reason !== 'not_placed' };
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
  async function alert(route, details, id, kind, holdCall = false, callId = '', emailKey = `${id}-alert-${kind}-0`) {
    return (await alertOutcome(route, details, id, kind, holdCall, callId, emailKey)).status;
  }
  // The same, plus whether any channel got through (delivered), so a request whose alert reached nobody can be retried.
  // emailKey is the Resend Idempotency-Key and the delivery-ledger ref. The new-job and hang-up alerts use the v1.5 key
  // (<id>-alert-<kind>-0, notes were always empty then); it must not change when notes are added later, and it is the
  // same ref office_retries uses, so the outbox, a Vapi retry and the office retry share one ledger per channel.
  // delayedMin: an office retry of a job saved over an hour ago (e.g. after a crash loop) says so in the SMS. The email keeps
  // its first payload: Resend refuses a reused Idempotency-Key with a new body, and the first try may have landed.
  async function alertOutcome(route, details, id, kind, holdCall = false, callId = '', emailKey = `${id}-alert-${kind}-0`, delayedMin = 0) {
    if (!route || (details.is_test && !route.alertTests)) return { status: details.is_test ? 'suppressed_test' : 'not_configured', delivered: false };
    const text = alertText(route, details, kind, 'sms', { delayedMin });
    const jobs = [];
    if (env.TELNYX_API_KEY && env.TELNYX_FROM) {
      for (const to of route.sms || []) jobs.push(sendOnce(emailKey, `sms:${to}`, () => send('https://api.telnyx.com/v2/messages', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.TELNYX_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.TELNYX_FROM, to, text }) }).then(async r => {
          // Log only Telnyx error codes (e.g. 40300 recipient opted out, 40010 number not 10DLC-linked), never the text.
          if (!r.ok) { let codes = ''; try { codes = (await r.clone().json()).errors?.map(e => e.code).join(',') || ''; } catch {}
            console.warn(`sms alert failed: HTTP ${r.status} ${codes}`); }
          return r;
        }, error => { console.warn('sms alert failed: no response'); throw error; })));
    }
    if (env.RESEND_API_KEY && env.EMAIL_FROM && (route.email || []).length) {
      const emailText = alertText(route, details, kind, 'email');
      jobs.push(sendOnce(emailKey, 'email', () => send('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': emailKey },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: route.email, subject: alertSubject(details, kind), text: `${emailText}\n\nRequest reference: ${id}` }) })
        .then(r => { if (!r.ok) console.warn(`alert email failed: HTTP ${r.status} request=${id}`); return r; },
          error => { console.warn(`alert email failed: no response request=${id}`); throw error; })));
    }
    const urgent = isUrgent(details.issue);
    if (kind === 'new' && urgent && !holdCall && callId) jobs.push(...ring(callId, route, details));
    return settleOutcome(jobs);
  }
  async function settleOutcome(jobs) {
    if (!jobs.length) return { status: 'not_configured', delivered: false };
    const ok = (await Promise.allSettled(jobs)).map(s => s.status === 'fulfilled' && !!s.value?.ok);
    return { status: ok.every(Boolean) ? 'sent' : 'needs_review', delivered: ok.some(Boolean) };
  }
  const settle = async jobs => (await settleOutcome(jobs)).status;
  // Saves a request and, for a live one, arms its office-alert retry in the same transaction, before any network call:
  // a crash or redeploy while the alert is going out still leaves the retry for sweepOfficeRetries. Returns insert's info.
  // also: more writes for the same transaction (submit's transfer hold and outbox row).
  function saveWithRetry(orIgnore, callId, id, details, result, assistantId, kind, routed, also = () => {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const info = insert(orIgnore, callId, id, details, result, assistantId);
      if (info.changes && routed && !details.is_test) db.prepare('INSERT OR IGNORE INTO office_retries (call_id, kind, email_key, next_at) VALUES (?, ?, ?, ?)')
        .run(callId, kind, `${id}-alert-${kind}-0`, Date.now() + OFFICE_RETRY_MS);
      if (info.changes) also();
      db.exec('COMMIT');
      return info;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // The first alert finished: a channel got through (or there was nothing to send), so the retry is closed. Otherwise it
  // stays armed. Returns true when it stays. Also called when a Vapi retry or the outbox sweep re-sends the alert: one that
  // got a channel through closes the retry even after office retries began (the shared ledger means nothing is resent).
  function settleOfficeRetry(callId, id, kind, outcome) {
    if (outcome.status === 'needs_review' && !outcome.delivered) {
      console.warn(`office-alert reached nobody call=${callId} request=${id} kind=${kind}: retrying every ${OFFICE_RETRY_MS / 1000} s, ${OFFICE_RETRIES} times`);
      return true;
    }
    db.prepare(`UPDATE office_retries SET done = ? WHERE call_id = ? AND done IS NULL AND (attempts = 0 OR ?)`).run(outcome.status, callId, outcome.delivered ? 1 : 0);
    return false;
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
  // Office alerts that reached nobody (office_retries is the only sweeper that retries them): send the SMS and email again every minute (no new ring: urgent escalation owns
  // that), 5 times, keeping the first email's Resend key. Then Anchorline gets one notice, retried every minute for up
  // to an hour until accepted. A route that is gone, or a retry that throws, still ends in that notice.
  async function retryOffice(row, now) {
    const set = fields => db.prepare(`UPDATE office_retries SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')} WHERE call_id = ?`)
      .run(...Object.values(fields), row.call_id);
    const attempts = row.attempts + 1;
    try {
      const request = db.prepare('SELECT id, created_at, details, result, assistant_id FROM requests WHERE call_id = ?').get(row.call_id);
      if (!request) { set({ done: 'no_request' }); console.warn(`office-alert retry call=${row.call_id}: request row is gone`); return 'no_request'; }
      const details = JSON.parse(request.details);
      if (details.is_test) { set({ done: 'suppressed_test' }); return 'suppressed_test'; }
      const route = routeOf(request.assistant_id);
      let why = `Every alert channel failed ${Math.min(row.attempts + 1, OFFICE_RETRIES + 1)} times`;
      // After a crash, alertOutcome skips channels the ledger has as sent and sends the cut ones once.
      // Known gap: sent_after_retry may label a row whose channels were finished after a crash.
      // Known gap: a Telnyx SMS that timed out after 8 s but was delivered is recorded failed and re-sent by a retry (same as main).
      if (route && row.attempts < OFFICE_RETRIES) {
        // A job saved over an hour ago still goes to the shop (nothing is lost), once, marked as delayed.
        const age = Math.floor((now - Date.parse(request.created_at)) / 60000);
        const delayedMin = age >= 60 ? age : 0;
        if (delayedMin) console.warn(`office-alert delayed call=${row.call_id} request=${request.id} age_min=${delayedMin}`);
        const outcome = await alertOutcome(route, details, request.id, row.kind, true, '', row.email_key, delayedMin);
        if (outcome.delivered) {
          set({ attempts, done: 'sent' });
          // Only office_alert changes: a submit finishing its receipts at the same moment keeps its own fields.
          db.prepare(`UPDATE requests SET result = json_set(result, '$.office_alert', 'sent_after_retry') WHERE call_id = ? AND json_valid(result)`).run(row.call_id);
          console.log(`office-alert retry call=${row.call_id} request=${request.id} attempt=${attempts} outcome=sent`);
          return 'sent';
        }
        if (outcome.status === 'needs_review') {
          set({ attempts, next_at: now + OFFICE_RETRY_MS });
          console.warn(`office-alert retry call=${row.call_id} request=${request.id} attempt=${attempts} outcome=reached_nobody`);
          return 'retrying';
        }
        why = `The alert could not be retried (${outcome.status}) after the first try failed`;
      } else if (!route) why = 'The shop\'s alert route is gone, so the alert could not be retried';
      // Tell Anchorline instead (same Idempotency-Key, so at most one email lands).
      const first = row.attempts <= OFFICE_RETRIES;
      const notice = await officeNotice(`Office alert failed: ${alertSubject(details, row.kind)}`.slice(0, 120),
        `${why} for this request (${route?.business || 'no route'}). Nobody at the office has been told.\nCall the shop and pass it on.\n\n` +
        `${route ? alertText(route, details, row.kind, 'email') : `Issue: ${details.issue}`}\n\nRequest reference: ${request.id}`, `${request.id}-office-alert-failed`);
      const base = Math.max(attempts, OFFICE_RETRIES + 1);
      if (notice === 'accepted' || notice === 'not_requested') set({ attempts: base, done: `gave_up_notice_${notice}` });
      else set(base >= OFFICE_RETRIES + 60 ? { attempts: base, done: 'gave_up_silent' } : { attempts: base, next_at: now + OFFICE_RETRY_MS });
      (first ? console.error : console.warn)(`office-alert GAVE UP call=${row.call_id} request=${request.id} anchorline_notice=${notice}`);
      return `gave_up_${notice}`;
    } catch {
      // Counted like a failed try. Once the retries are used up Anchorline is told (by call ID: the request may be unreadable).
      if (attempts > OFFICE_RETRIES) {
        const notice = await officeNotice('Office alert failed: request could not be read',
          `An office alert reached nobody and its retry keeps failing. Nobody at the office has been told.\nVapi call ID: ${row.call_id}`,
          `${row.call_id}-office-alert-error`).catch(() => 'needs_review');
        if (notice === 'accepted' || notice === 'not_requested') { set({ attempts, done: `gave_up_error_notice_${notice}` }); console.error(`office-alert GAVE UP call=${row.call_id} retry kept failing, anchorline_notice=${notice}`); return 'error'; }
      }
      set(attempts >= OFFICE_RETRIES + 60 ? { attempts, done: 'gave_up_error' } : { attempts, next_at: now + OFFICE_RETRY_MS });
      console.warn(`office-alert retry call=${row.call_id} attempt=${attempts} failed`);
      return 'error';
    }
  }
  // Due retries run side by side on their own timer, so a slow provider never holds up urgent transfers or escalations.
  async function sweepOfficeRetries(now = Date.now()) {
    if (!db) return [];
    const due = db.prepare('SELECT * FROM office_retries WHERE done IS NULL AND next_at <= ? ORDER BY next_at LIMIT 20').all(now);
    return Promise.all(due.map(row => retryOffice(row, now)));
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
    const jobs = rows.filter(r => !r.hangup).map(r => isUrgent(r.details.issue) ? { ...r, ring: ringSummary(r.call_id) } : r);
    return { calls, jobs, hangups: rows.filter(r => r.hangup) };
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
  // Retry safety for submit_service_request, add_request_note and add_customer_email. The change commits (with an outbox
  // row) before any network call; then deliver* sends whatever has not gone out and stores the final result. A repeat
  // (same call; for notes and emails the same toolCall id and arguments) shares the running attempt, or re-runs the sends
  // when the stored result is still pending (cut off by a restart) or needs_review (a send failed; the ledger skips the
  // channels that went out), else returns the stored result. Repeats are marked duplicate: true.
  const flights = new Map();
  const run = (ref, work) => {
    if (flights.has(ref)) return flights.get(ref);
    const task = work().finally(() => flights.delete(ref));
    flights.set(ref, task);
    return task;
  };
  const unfinished = value => value === 'pending' || value === 'needs_review';
  async function repeat(ref, stored, redo) {
    const result = flights.has(ref) ? await flights.get(ref) : Object.values(stored).some(unfinished) ? await redo() : stored;
    return { ...result, duplicate: true };
  }
  const addOutbox = (ref, kind, callId, toolCallId = null, argsKey = null) => db.prepare(`INSERT OR REPLACE INTO outbox
    (ref, kind, call_id, tool_call_id, args_key, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ref, kind, callId, toolCallId, argsKey, Date.now(), Date.now() + 30000);
  // A note alert reached the office when it needed nothing (sent, test, no route) or at least one of its channels went out.
  // Until then its outbox row stays, and the sweep tries the failed channels again. (The new-job alert is not kept here:
  // office_retries is the only sweeper that retries a new-job or hang-up alert that reached nobody; a Vapi retry of a
  // needs_review submit also re-sends its failed channels, through the same ledger.)
  const officeReached = (result, alertKey) => result.office_alert !== 'needs_review' && result.office_alert !== 'pending'
    || !!db.prepare("SELECT 1 FROM deliveries WHERE ref = ? AND status = 'sent'").get(alertKey);
  const doneOutbox = ref => db.prepare('DELETE FROM outbox WHERE ref = ?').run(ref);
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try { work(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  function deliverSubmit(callId) {
    const ref = `submit\n${callId}`;
    return run(ref, async () => {
      const row = db.prepare('SELECT id, details, result FROM requests WHERE call_id = ?').get(callId);
      const details = JSON.parse(row.details), result = JSON.parse(row.result), route = routeOf(details.assistant_id);
      // The new-job alert keeps the v1.5 key and the office_retries ledger ref. Its retry is settled the moment the alert
      // resolves (not after the receipts), so a crash in between can't re-text.
      let retry = '';
      const officeAlert = unfinished(result.office_alert)
        ? alertOutcome(route, details, row.id, 'new', result.live_transfer === 'available', callId, `${row.id}-alert-new-0`)
          .then(outcome => { retry = settleOfficeRetry(callId, row.id, 'new', outcome) ? ' retry=queued' : ''; return outcome.status; })
        : result.office_alert;
      const [callerEmail, anchorlineEmail] = await Promise.all([
        // Keyed by address (callerKey): after an add_customer_email correction to Y, a submit retry finds Y's confirmation
        // in the ledger instead of sending it again under <id>-caller. The first address keeps <id>-caller (v1.5).
        unfinished(result.caller_email) ? receipt(details.email, details, row.id, 'caller', route, callerKey(row.id, details.email)) : result.caller_email,
        unfinished(result.anchorline_email) ? receipt(env.OFFICE_EMAIL, details, row.id, 'office') : result.anchorline_email]);
      Object.assign(result, { caller_email: callerEmail, anchorline_email: anchorlineEmail, office_alert: await officeAlert });
      // Only fields still unfinished in the stored row are written: an office retry's sent_after_retry (or a stale
      // drop) stored meanwhile is kept, and the caller is told what is stored.
      const keep = field => `'$.${field}', CASE WHEN json_extract(result, '$.${field}') IN ('pending', 'needs_review') THEN ? ELSE json_extract(result, '$.${field}') END`;
      db.prepare(`UPDATE requests SET result = json_set(result, ${['caller_email', 'anchorline_email', 'office_alert'].map(keep).join(', ')}) WHERE call_id = ?`)
        .run(result.caller_email, result.anchorline_email, result.office_alert, callId);
      Object.assign(result, JSON.parse(db.prepare('SELECT result FROM requests WHERE call_id = ?').get(callId).result));
      // The sends ran to the end: the outbox is done. A new-job alert that reached nobody stays with office_retries.
      doneOutbox(ref);
      // Operational log only: statuses and IDs, never caller details.
      console.log(`submit call=${logSafe(callId)} request=${row.id} urgent=${isUrgent(details.issue) ? 'yes' : 'no'} office_alert=${result.office_alert} caller_email=${result.caller_email} anchorline_email=${result.anchorline_email}${retry}`);
      return result;
    });
  }
  const toolRef = (name, callId, toolCallId, argsKey) => `${name}\n${callId}\n${toolCallId}\n${argsKey}`;
  const toolRow = (name, callId, toolCallId, argsKey) => db.prepare(`SELECT arg, assistant_id, result FROM tool_calls
    WHERE call_id = ? AND name = ? AND tool_call_id = ? AND args_key = ?`).get(callId, name, toolCallId, argsKey);
  // add_request_note and add_customer_email: a toolCall id already stored with other arguments is refused as a conflict (a
  // Vapi retry repeats the same body), never a new change. submit keeps main's one-request-per-call rule: a repeat with
  // other arguments gets the stored result, marked duplicate.
  const reused = (name, callId, toolCallId) => !!db.prepare('SELECT 1 FROM tool_calls WHERE call_id = ? AND name = ? AND tool_call_id = ?').get(callId, name, toolCallId);
  function deliverTool(name, callId, toolCallId, argsKey) {
    const ref = toolRef(name, callId, toolCallId, argsKey);
    return run(ref, async () => {
      const tool = toolRow(name, callId, toolCallId, argsKey);
      const row = db.prepare('SELECT id, details FROM requests WHERE call_id = ?').get(callId);
      const result = JSON.parse(tool.result), details = JSON.parse(row.details), route = routeOf(tool.assistant_id);
      const noteKey = `${row.id}-alert-note-${sha(`${toolCallId}\n${argsKey}`).slice(0, 32)}`;
      if (name === 'add_request_note' && unfinished(result.office_alert)) {
        const noted = { ...details, notes: [...(details.notes || []).filter(n => n !== tool.arg), tool.arg] };
        result.office_alert = await alert(route, noted, row.id, 'note', false, '', noteKey);
      }
      // A pending confirmation for an address the caller has since corrected is not sent.
      if (name === 'add_customer_email' && unfinished(result.caller_email)) result.caller_email = String(details.email).toLowerCase() !== tool.arg.toLowerCase()
        ? 'superseded' : await receipt(tool.arg, details, row.id, 'caller', route, callerKey(row.id, tool.arg));
      db.prepare('UPDATE tool_calls SET result = ? WHERE call_id = ? AND name = ? AND tool_call_id = ? AND args_key = ?').run(JSON.stringify(result), callId, name, toolCallId, argsKey);
      if (name === 'add_request_note' ? officeReached(result, noteKey) : result.caller_email !== 'needs_review') doneOutbox(ref);
      return result;
    });
  }
  // Saves the changed request and the tool call in one transaction, then sends.
  function saveTool(name, callId, toolCallId, argsKey, arg, assistantId, details, result) {
    const ref = toolRef(name, callId, toolCallId, argsKey);
    transaction(() => {
      db.prepare('INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(callId, name, toolCallId, argsKey, arg, assistantId || null, new Date().toISOString(), JSON.stringify(result));
      db.prepare('UPDATE requests SET details = ? WHERE call_id = ?').run(JSON.stringify(details), callId);
      addOutbox(ref, name, callId, toolCallId, argsKey);
    });
    return deliverTool(name, callId, toolCallId, argsKey);
  }
  // A note is a new note unless it is a repeat of the same tool call (same toolCall id and text): the caller may
  // legitimately say the same thing twice (A, then B, then A again).
  async function addNote(callId, args, assistantId, toolCallId = '') {
    const row = db.prepare('SELECT id, details FROM requests WHERE call_id = ?').get(callId);
    if (!row) return failure('No saved request yet; save the request first');
    const note = typeof args?.note === 'string' ? args.note.trim() : '';
    if (!note || note.length > 1000) return failure('Missing or invalid note');
    const name = 'add_request_note', argsKey = sha(note), stored = toolRow(name, callId, toolCallId, argsKey);
    if (!stored && reused(name, callId, toolCallId)) return failure('Not added: this tool call was already used for a different note. Call add_request_note again.');
    if (stored) return repeat(toolRef(name, callId, toolCallId, argsKey), JSON.parse(stored.result), () => deliverTool(name, callId, toolCallId, argsKey));
    const details = JSON.parse(row.details);
    details.notes = [...(details.notes || []), note].slice(-20);
    return saveTool(name, callId, toolCallId, argsKey, note, assistantId, details, { saved: true, request_id: row.id, note_added: true, office_alert: 'pending' });
  }
  // An email given after the request was saved: only accepted once spelled back and confirmed, then the confirmation goes out.
  async function addEmail(callId, args, assistantId, toolCallId = '') {
    const row = db.prepare('SELECT id, details FROM requests WHERE call_id = ?').get(callId);
    if (!row) return failure('No saved request yet; save the request first');
    if (args?.confirmed_after_spelling_back !== true) return failure('Not added: spell the email back letter by letter and get a clear yes first.');
    const email = typeof args?.email === 'string' ? args.email.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return failure('Invalid email');
    const name = 'add_customer_email', argsKey = sha(email.toLowerCase()), stored = toolRow(name, callId, toolCallId, argsKey);
    if (!stored && reused(name, callId, toolCallId)) return failure('Not added: this tool call was already used for a different email. Call add_customer_email again.');
    if (stored) return repeat(toolRef(name, callId, toolCallId, argsKey), JSON.parse(stored.result), () => deliverTool(name, callId, toolCallId, argsKey));
    const details = JSON.parse(row.details);
    details.email = email;
    return saveTool(name, callId, toolCallId, argsKey, email, assistantId, details,
      { saved: true, request_id: row.id, email_added: true, caller_email: details.is_test ? 'suppressed_test' : 'pending' });
  }
  // The outbox gave up on a note alert that reached no channel (5 passes failed, or the row went stale after a crash loop
  // of over an hour): Anchorline (OFFICE_EMAIL) is told once, in the office_retries style, retried every minute until
  // accepted for up to an hour (same Idempotency-Key, so at most one lands). Logs carry IDs only.
  async function outboxNotice(row, now) {
    const tries = row.attempts + 1;
    const finish = (outcome, log = console.error) => { doneOutbox(row.ref); log(`outbox GAVE UP kind=${row.kind} call=${logSafe(row.call_id)} reason=${row.gave_up} anchorline_notice=${outcome}`); return outcome; };
    try {
      const request = db.prepare('SELECT id, details, assistant_id FROM requests WHERE call_id = ?').get(row.call_id);
      const tool = row.tool_call_id != null ? toolRow(row.kind, row.call_id, row.tool_call_id, row.args_key) : null;
      if (!request || !tool) return finish('no_request', console.warn);
      const details = JSON.parse(request.details), route = routeOf(tool.assistant_id);
      if (details.is_test && !route?.alertTests) return finish('suppressed_test', console.warn);
      const noted = { ...details, notes: [...(details.notes || []).filter(n => n !== tool.arg), tool.arg] };
      const why = row.gave_up === 'stale' ? 'The server was down or restarting for over an hour before this update could be sent'
        : `Every alert channel failed ${OFFICE_RETRIES + 1} times`;
      const notice = await officeNotice(`Office alert failed: ${alertSubject(noted, 'note')}`.slice(0, 120),
        `${why} for this request (${route?.business || 'no route'}). Nobody at the office has been told about this update.\nCall the shop and pass it on.\n\n` +
        `${route ? alertText(route, noted, 'note', 'email') : `Note: ${tool.arg}`}\n\nRequest reference: ${request.id}`,
        `${request.id}-office-alert-failed-note-${sha(row.ref).slice(0, 16)}`);
      if (notice === 'accepted' || notice === 'not_requested') return finish(notice);
    } catch { /* counted like a failed notice */ }
    if (tries >= OFFICE_RETRIES + 60) return finish('gave_up_silent');
    db.prepare('UPDATE outbox SET attempts = ?, due_at = ? WHERE ref = ?').run(tries, now + OFFICE_RETRY_MS, row.ref);
    console.warn(`outbox notice call=${logSafe(row.call_id)} kind=${row.kind} attempt=${tries} anchorline_notice=needs_review`);
    return 'needs_review';
  }
  // Has a stored note's alert reached any channel? (ledger, so a row cut off mid-run is judged by what really went out)
  const noteReached = row => {
    const tool = toolRow(row.kind, row.call_id, row.tool_call_id, row.args_key);
    const request = db.prepare('SELECT id FROM requests WHERE call_id = ?').get(row.call_id);
    if (!tool || !request) return true;
    return officeReached(JSON.parse(tool.result), `${request.id}-alert-note-${sha(`${row.tool_call_id}\n${row.args_key}`).slice(0, 32)}`);
  };
  // Restart safety net: saved work whose sends never finished is finished here even when Vapi does not retry, 30 s after
  // it was saved (if not running in this process); a note alert or caller confirmation that failed is tried again, up to
  // 5 passes a minute apart. The new-job and hang-up alerts' "reached nobody" retries and notice belong to office_retries
  // (sweepOfficeRetries), never to the outbox: a submit row is done once its sends ran to the end.
  // A row older than an hour (a crash loop, or a rollback) is dropped, never sent late; a note alert in it that reached
  // nobody is reported to Anchorline (outboxNotice). A submit row's alert is still owned by office_retries.
  async function sweepOutbox(now = Date.now()) {
    if (!db) return [];
    const done = [];
    for (const row of db.prepare('SELECT * FROM outbox WHERE due_at <= ? ORDER BY due_at LIMIT 20').all(now)) {
      if (flights.has(row.ref)) continue;
      if (row.gave_up) { await outboxNotice(row, now); continue; }
      const note = row.kind === 'add_request_note';
      const stale = row.created_at < now - 3600000;
      if (stale || row.attempts >= 5) {
        let reached = true;
        try { reached = !note || noteReached(row); } catch {}
        if (!reached) {
          db.prepare('UPDATE outbox SET gave_up = ?, attempts = 0 WHERE ref = ?').run(stale ? 'stale' : 'passes', row.ref);
          await outboxNotice({ ...row, gave_up: stale ? 'stale' : 'passes', attempts: 0 }, now);
          continue;
        }
        doneOutbox(row.ref);
        // A stale submit's receipts are not sent hours late: unsent ones get a terminal status (the alert stays with office_retries).
        const dropped = stale && row.kind === 'submit' ? db.prepare(`UPDATE requests SET result = json_set(result,
          '$.caller_email', CASE WHEN json_extract(result, '$.caller_email') IN ('pending', 'needs_review') THEN 'dropped_stale' ELSE json_extract(result, '$.caller_email') END,
          '$.anchorline_email', CASE WHEN json_extract(result, '$.anchorline_email') IN ('pending', 'needs_review') THEN 'dropped_stale' ELSE json_extract(result, '$.anchorline_email') END)
          WHERE call_id = ? AND json_valid(result) AND (json_extract(result, '$.caller_email') IN ('pending', 'needs_review') OR json_extract(result, '$.anchorline_email') IN ('pending', 'needs_review'))`).run(row.call_id).changes : 0;
        const owner = row.kind === 'submit' ? ` office_retries=${db.prepare('SELECT done FROM office_retries WHERE call_id = ?').get(row.call_id)?.done ?? 'armed_or_none'} receipts=${dropped ? 'dropped_stale' : 'done'}` : '';
        (stale ? console.warn : console.error)(`outbox ${stale ? 'stale-dropped' : 'GAVE UP'} kind=${row.kind} call=${logSafe(row.call_id)}${owner}`);
        continue;
      }
      db.prepare('UPDATE outbox SET attempts = attempts + 1, due_at = ? WHERE ref = ?').run(now + 60000, row.ref);
      try {
        const result = row.kind === 'submit' ? await deliverSubmit(row.call_id) : await deliverTool(row.kind, row.call_id, row.tool_call_id, row.args_key);
        console.log(`outbox kind=${row.kind} call=${logSafe(row.call_id)} outcome=${toolOutcome(result)}`);
        done.push(row.ref);
      } catch { console.warn(`outbox failed kind=${row.kind} call=${logSafe(row.call_id)}`); }
    }
    return done;
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
    // From the report itself (no extra Vapi call): the end of the transcript, and the callback number from Emma's own
    // submit_service_request call with callback_read_back true, e.g. a save that failed or a call that dropped mid-save
    // (confirmedCallback; callback_source 'tool'). Without one, callback_phone and callback_source stay '' and the office
    // uses the caller ID. Any other number said on the call can appear, never labelled confirmed, in the transcript excerpt
    // and in Vapi's own call summary, both of which go into the issue text below.
    const excerpt = greeting ? '' : transcriptExcerpt(message);
    const callback = greeting ? '' : confirmedCallback(message);
    const issue = greeting ? 'Hung up during the greeting, before giving any details' :
      `${summary ? `Hung up before finishing. Summary: ${summary}` : excerpt ? 'Hung up before finishing' : 'Hung up before giving details'}` +
      `${excerpt ? `\nTranscript (end of call):\n${excerpt}` : ''}`;
    const details = { name: 'Unknown caller', address: '', issue, is_test: /test call/i.test(said), callback_phone: callback, callback_source: callback ? 'tool' : '', caller_id: callerId, email: '', notes: [],
      ...(greeting ? { greeting_hangup: true } : {}), ...(recordingOf(message) ? { recording_url: recordingOf(message) } : {}) };
    const id = randomUUID();
    const result = { saved: true, retryable: false, request_id: id, source: 'hangup', caller_email: 'not_requested', anchorline_email: 'not_requested' };
    classify(details, callId, message);
    const inserted = saveWithRetry(true, callId, id, details, result, assistantIdOf(message), 'hangup', !!route);
    if (!inserted.changes) return 'already_saved';
    const outcome = await alertOutcome(route, details, id, 'hangup');
    result.office_alert = outcome.status;
    db.prepare('UPDATE requests SET result = ? WHERE call_id = ?').run(JSON.stringify(result), callId);
    const retry = settleOfficeRetry(callId, id, 'hangup', outcome) ? ' retry=queued' : '';
    return `${greeting ? 'greeting_hangup' : 'hangup'}_request_created alert=${result.office_alert}${retry}`;
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
    if (old) return repeat(`submit\n${callId}`, JSON.parse(old.result), () => deliverSubmit(callId));
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
    if (args.email_status === 'skipped_emergency' && !isUrgent(details.issue))
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
    // Urgent job with an owner's cell on the route: offer a live transfer and hold the spoken alert call for its outcome.
    const transfer = canTransfer(routeFor(message), details);
    const result = { saved: true, retryable: false, request_id: id,
      caller_email: !details.email ? 'not_requested' : details.is_test ? 'suppressed_test' : 'pending',
      anchorline_email: !env.OFFICE_EMAIL ? 'not_requested' : details.is_test ? 'suppressed_test' : 'pending',
      ...(transfer ? { live_transfer: 'available' } : {}), office_alert: 'pending' };
    // Commit before any network operation, in one transaction: one request per Vapi call, its office-alert retry
    // (office_retries), its transfer hold and its outbox row survive retries and restarts. A restart mid-send is finished
    // by the next Vapi retry or by sweepOutbox; an alert that reached nobody is retried by sweepOfficeRetries only.
    saveWithRetry(false, callId, id, details, result, assistantIdOf(message), 'new', !!routeFor(message), () => {
      if (transfer) db.prepare('INSERT OR IGNORE INTO transfers VALUES (?, ?, ?, ?, ?)').run(callId, assistantIdOf(message), 'pending', Date.now() + fallbackMs, new Date().toISOString());
      addOutbox(`submit\n${callId}`, 'submit', callId);
    });
    return deliverSubmit(callId);
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
        status: 'ok', service: 'Anchorline Vapi Receptionist', version: '1.8.1', ready, trials_enabled: trialsEnabled,
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
        const started = Date.now();
        const callId = conversationKey(message);
        const name = tool.function?.name || tool.name;
        if (!callId) result = failure('Missing Vapi call, chat or session ID');
        else if (name === 'add_request_note') {
          try {
            let args = tool.function?.arguments ?? tool.parameters;
            if (typeof args === 'string') args = JSON.parse(args);
            result = await addNote(callId, args, assistantIdOf(message), tool.id);
          } catch { result = failure('Unable to add note'); }
        }
        else if (name === 'add_customer_email') {
          try {
            let args = tool.function?.arguments ?? tool.parameters;
            if (typeof args === 'string') args = JSON.parse(args);
            result = await addEmail(callId, args, assistantIdOf(message), tool.id);
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
            result = await submit(callId, args, message);
          } catch {
            // Never claim a save failed if SQLite already persisted it before an error.
            const saved = db.prepare('SELECT result FROM requests WHERE call_id = ?').get(callId);
            result = saved ? JSON.parse(saved.result) : failure('Unable to process request');
          }
        }
        results.push({ toolCallId: tool.id, result: JSON.stringify(result) });
        // Operational log only: tool, IDs, outcome and time, never arguments or caller details.
        console.log(`tool-call name=${logSafe(name)} call=${logSafe(callId)} tool_call=${logSafe(tool.id)} outcome=${toolOutcome(result)} ms=${Date.now() - started}`);
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
  let retrying = false;
  const officeSweeper = db ? setInterval(async () => {
    if (retrying) return;
    retrying = true;
    try { await sweepOfficeRetries().catch(() => console.warn('office-alert sweep failed')); } finally { retrying = false; }
  }, 5000) : null;
  officeSweeper?.unref();
  // The outbox (finishing sends cut off by a restart) has its own timer too: a hanging Telnyx or Resend never holds up the
  // held urgent rings above. It may run alongside the office sweep: both go through the shared delivery ledger and its joins.
  let finishing = false;
  const outboxSweeper = db ? setInterval(async () => {
    if (finishing) return;
    finishing = true;
    try { await sweepOutbox().catch(() => console.warn('outbox sweep failed')); } finally { finishing = false; }
  }, 5000) : null;
  outboxSweeper?.unref();
  // Trials: hourly (results emails, trial end, stuck provisioning), and once a minute after startup.
  const trialSweep = () => trials.sweep().catch(() => console.warn('trial sweep failed'));
  const trialSweeper = trialsEnabled ? setInterval(trialSweep, 3600000) : null;
  const trialStart = trialsEnabled ? setTimeout(trialSweep, 60000) : null;
  trialSweeper?.unref(); trialStart?.unref();
  server.sweepTransfers = sweepTransfers;
  server.sweepOutbox = sweepOutbox;
  server.sweepEscalations = sweepEscalations;
  server.sweepOfficeRetries = sweepOfficeRetries;
  server.sendDigests = sendDigests;
  server.trials = trials;
  server.on('close', () => { clearInterval(sweeper); clearInterval(officeSweeper); clearInterval(outboxSweeper); clearInterval(trialSweeper); clearTimeout(trialStart); db?.close(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('Anchorline receptionist listening'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
