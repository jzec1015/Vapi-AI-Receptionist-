import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp, alertSubject, answeredCall, digestWindow, alertCall, digestEmail } from './server.mjs';

const key = 'synthetic-test-key-not-used-in-production';
const route = { business: 'Gold Star Plumbing', email: ['office@example.com'], sms: [], call: ['+15550000999'], backup: '+15550000888' };
const baseEnv = { VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'from-line', RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com', OFFICE_EMAIL: 'ops@example.com' };
const intake = { name: 'Linda Harper', address: '1412 Dickerson Pike, Nashville, TN 37207', issue: 'URGENT - burst pipe', is_test: false,
  callback_phone: '6155550142', callback_read_back: true, email_status: 'skipped_emergency' };
const call = (id, extra = {}) => ({ id, assistantId: 'client-a', type: 'inboundPhoneCall', customer: { number: '+16155550100' }, ...extra });
const toolCall = (id, args) => ({ message: { type: 'tool-calls', call: call(id), toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } });
const report = (id, durationSeconds, extra = {}) => ({ message: { type: 'end-of-call-report', durationSeconds, endedReason: 'customer-ended-call', call: call(id), ...extra } });
const MIN = 60000;

// rings: what GET https://api.vapi.ai/call/<id> answers per Vapi call id (missing = still ringing). POST /call answers
// { id: 'ring-N' } unless refuse is set.
async function fixture(t, { routes = { 'client-a': route }, env = {}, rings = {}, refuse = false, dir = mkdtempSync(join(tmpdir(), 'escalation-test-')), keep = false } = {}) {
  const sent = [];
  let n = 0;
  const send = async (url, init) => {
    if (init.method === 'GET') { const id = url.split('/').pop(); sent.push({ url, method: 'GET' }); return Response.json(rings[id] || { id, status: 'ringing' }); }
    const body = JSON.parse(init.body);
    sent.push({ url, body, key: init.headers['Idempotency-Key'] });
    if (url === 'https://api.vapi.ai/call') return refuse ? new Response('{}', { status: 500 }) : Response.json({ id: `ring-${++n}` }, { status: 201 });
    return new Response('{}', { status: 200 });
  };
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ALERT_ROUTES: JSON.stringify(routes), ...baseEnv, ...env }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); if (app.listening) await new Promise(resolve => app.close(resolve)); if (!keep) rmSync(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = async body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) });
  const ringsTo = () => sent.filter(s => s.url === 'https://api.vapi.ai/call').map(s => s.body.customer.number);
  const emails = () => sent.filter(s => s.url.includes('resend'));
  return { post, sent, app, dir, ringsTo, emails };
}
const ended = (endedReason, seconds = 40) => ({ status: 'ended', endedReason, startedAt: '2026-10-16T10:00:00.000Z', endedAt: new Date(Date.parse('2026-10-16T10:00:00.000Z') + seconds * 1000).toISOString() });

test('lock-screen subjects: what, where, who to call, never over 90 characters', () => {
  assert.equal(alertSubject({ ...intake, callback_source: 'tool', notes: [] }), 'URGENT – burst pipe – 1412 Dickerson Pike – (615) 555-0142');
  assert.equal(alertSubject({ ...intake, callback_source: 'tool', issue: 'Water heater quote', notes: [] }), 'New job – Water heater quote – 1412 Dickerson Pike – (615) 555-0142');
  assert.equal(alertSubject({ ...intake, callback_source: 'tool', notes: [] }, 'unanswered'), 'UNANSWERED URGENT – burst pipe – 1412 Dickerson Pike – (615) 555-0142');
  assert.equal(alertSubject({ ...intake, callback_source: 'tool', issue: 'Faucet', notes: ['Gate code 4471'] }, 'note'), 'Update – Gate code 4471 – 1412 Dickerson Pike – (615) 555-0142');
  assert.equal(alertSubject({ issue: 'x', caller_id: '+16155550100', greeting_hangup: true }, 'hangup'), 'Caller hung up during greeting – (615) 555-0100 – call them back');
  assert.equal(alertSubject({ ...intake, callback_source: 'tool', issue: 'Water heater is 15 years old', job_type: 'Water heater replacement', notes: [] }),
    'New job – Water heater is 15 years old – 1412 Dickerson Pike – (615) 555-0142', 'high-value subjects stay "New job"');
  assert.equal(alertSubject({ ...intake, callback_source: 'tool', job_size: 'Big job (half day+)', notes: [] }), 'URGENT – burst pipe – 1412 Dickerson Pike – (615) 555-0142', 'urgent subject unchanged');
  assert.ok(alertSubject({ ...intake, callback_source: 'tool', issue: 'repipe ' + 'the whole downstairs bathroom and kitchen '.repeat(4), notes: [] }).length <= 90);
  const long = alertSubject({ ...intake, callback_source: 'tool', issue: 'URGENT - ' + 'water pouring through the ceiling of the downstairs bathroom '.repeat(4),
    address: '98765 Old Hickory Boulevard Apartment 1204 Building C', callback_phone: '', caller_id: '+16155550100', notes: [] });
  assert.ok(long.length <= 90, long);
  assert.equal(long, "URGENT – water pouring… – 98765 Old Hickory Boulevard… – (615) 555-0100 (caller ID)");
  const noAddress = alertSubject({ ...intake, callback_source: 'tool', address: '', notes: [] });
  assert.equal(noAddress, 'URGENT – burst pipe – (615) 555-0142');
});

test('only an ended call a person heard counts as answered', () => {
  for (const reason of ['assistant-ended-call', 'assistant-said-end-call-phrase']) assert.equal(answeredCall(reason, 20), true);
  assert.equal(answeredCall('customer-ended-call', 30), true);
  assert.equal(answeredCall('customer-ended-call', 5), false);
  for (const reason of ['customer-did-not-answer', 'customer-busy', 'voicemail', 'silence-timed-out', 'exceeded-max-duration', 'twilio-failed-to-connect-call', 'unknown', undefined])
    assert.equal(answeredCall(reason, 60), false, reason);
});

test('an unanswered urgent ring emails UNANSWERED URGENT, rings the backup, then retries the owner once', async t => {
  const rings = { 'ring-1': ended('customer-did-not-answer', 30) };
  const { post, app, ringsTo, emails } = await fixture(t, { rings });
  const now = Date.now();
  assert.equal((JSON.parse((await (await post(toolCall('u-1', intake))).json()).results[0].result)).office_alert, 'sent');
  assert.deepEqual(ringsTo(), ['+15550000999']);
  assert.deepEqual(await app.sweepEscalations(now + MIN), [], 'not judged before the ring could have ended');
  assert.deepEqual(await app.sweepEscalations(now + 3 * MIN), ['escalated']);
  const unanswered = emails().filter(e => e.body.subject.startsWith('UNANSWERED URGENT – '));
  assert.deepEqual(unanswered.map(e => e.body.to), [['office@example.com'], ['ops@example.com']]);
  assert.equal(unanswered[0].body.subject, 'UNANSWERED URGENT – burst pipe – 1412 Dickerson Pike – (615) 555-0142');
  assert.match(unanswered[0].body.text, /not answered: \(555\) 000-0999 \(customer did not answer\)\.\nEmma is calling the backup number \(555\) 000-0888 now\. Emma will ring \(555\) 000-0999 once more in about 2 minutes\./);
  assert.match(unanswered[0].body.text, /Linda Harper - \(615\) 555-0142[\s\S]*Request reference: /);
  assert.deepEqual(ringsTo(), ['+15550000999', '+15550000888']);
  rings['ring-2'] = ended('customer-busy', 0);
  assert.deepEqual(await app.sweepEscalations(now + 4 * MIN), [], 'the retry waits ~5 minutes after the first ring');
  assert.deepEqual(await app.sweepEscalations(now + 6 * MIN), ['retried']);
  assert.deepEqual(ringsTo(), ['+15550000999', '+15550000888', '+15550000999']);
  rings['ring-3'] = ended('voicemail', 50);
  assert.deepEqual(await app.sweepEscalations(now + 9 * MIN), ['unanswered']);
  for (const later of [10, 20, 60]) assert.deepEqual(await app.sweepEscalations(now + later * MIN), []);
  assert.equal(ringsTo().length, 3); assert.equal(emails().filter(e => /UNANSWERED/.test(e.body.subject)).length, 2);
});

test('the backup and retry rings say why they are calling', () => {
  const details = { ...intake, notes: [] };
  assert.match(alertCall(route, details, 'from', '+1555', false, 'backup').assistant.firstMessage, /couldn't reach the main number, so I'm calling you as the backup/);
  assert.match(alertCall(route, details, 'from', '+1555', false, 'retry').assistant.firstMessage, /This is my second try/);
  assert.doesNotMatch(alertCall(route, details, 'from', '+1555').assistant.firstMessage, /backup|second try/);
});

test('an answered urgent ring ends the escalation quietly', async t => {
  const { post, app, ringsTo, emails } = await fixture(t, { rings: { 'ring-1': ended('assistant-ended-call', 35) } });
  await post(toolCall('a-1', intake));
  const before = emails().length;
  assert.deepEqual(await app.sweepEscalations(Date.now() + 3 * MIN), ['answered']);
  assert.deepEqual(await app.sweepEscalations(Date.now() + 30 * MIN), []);
  assert.deepEqual(ringsTo(), ['+15550000999']); assert.equal(emails().length, before);
});

test('a ring still in progress is checked again; one Vapi never reports counts as unanswered after 10 minutes', async t => {
  const { post, app, emails } = await fixture(t);
  await post(toolCall('w-1', intake));
  const now = Date.now();
  assert.deepEqual(await app.sweepEscalations(now + 3 * MIN), ['waiting']);
  assert.deepEqual(await app.sweepEscalations(now + 3 * MIN + 1000), [], 'rechecked 30 s later, not every sweep');
  assert.deepEqual(await app.sweepEscalations(now + 11 * MIN), ['escalated']);
  assert.match(emails().find(e => /UNANSWERED/.test(e.body.subject)).body.text, /\(still ringing\)/);
});

test('a ring Vapi refuses escalates on the next sweep, without waiting', async t => {
  const { post, app, ringsTo, emails } = await fixture(t, { refuse: true });
  const saved = JSON.parse((await (await post(toolCall('f-1', intake))).json()).results[0].result);
  assert.equal(saved.office_alert, 'needs_review');
  assert.deepEqual(await app.sweepEscalations(Date.now() + 1000), ['escalated']);
  assert.equal(ringsTo().length, 2);
  assert.match(emails().find(e => /UNANSWERED/.test(e.body.subject)).body.text, /\(not placed\)/);
});

test('a backup that answers skips the retry', async t => {
  const rings = { 'ring-1': ended('customer-did-not-answer'), 'ring-2': ended('customer-ended-call', 40) };
  const { post, app, ringsTo } = await fixture(t, { rings });
  await post(toolCall('b-1', intake));
  const now = Date.now();
  assert.deepEqual(await app.sweepEscalations(now + 3 * MIN), ['escalated']);
  assert.deepEqual(await app.sweepEscalations(now + 6 * MIN), ['answered']);
  assert.deepEqual(ringsTo(), ['+15550000999', '+15550000888']);
});

test('no backup number: the email still goes and the owner is retried', async t => {
  const { post, app, ringsTo, emails } = await fixture(t, { routes: { 'client-a': { ...route, backup: undefined } }, rings: { 'ring-1': ended('customer-busy', 0) } });
  await post(toolCall('n-1', intake));
  const now = Date.now();
  assert.deepEqual(await app.sweepEscalations(now + 3 * MIN), ['escalated']);
  assert.doesNotMatch(emails().find(e => /UNANSWERED/.test(e.body.subject)).body.text, /backup/);
  assert.deepEqual(await app.sweepEscalations(now + 6 * MIN), ['retried']);
  assert.deepEqual(ringsTo(), ['+15550000999', '+15550000999']);
});

test('an escalation survives a restart', async t => {
  const rings = { 'ring-1': ended('customer-did-not-answer') };
  const first = await fixture(t, { rings, keep: true });
  await first.post(toolCall('r-1', intake));
  first.app.closeAllConnections(); await new Promise(resolve => first.app.close(resolve));
  const second = await fixture(t, { rings, dir: first.dir });
  assert.deepEqual(await second.app.sweepEscalations(Date.now() + 3 * MIN), ['escalated']);
  assert.deepEqual(second.ringsTo(), ['+15550000888']);
});

test('an alert call reported to the webhook records its outcome and is never a hang-up lead', async t => {
  const { post, app, ringsTo, emails, sent } = await fixture(t);
  await post(toolCall('e-1', intake));
  const before = emails().length;
  await post({ message: { type: 'end-of-call-report', endedReason: 'customer-did-not-answer', durationSeconds: 0,
    call: { id: 'ring-1', type: 'outboundPhoneCall', customer: { number: '+15550000999' } } } });
  assert.equal(emails().length, before, 'no "caller hung up" email about the owner');
  assert.deepEqual(await app.sweepEscalations(Date.now() + 3 * MIN), ['escalated']);
  assert.equal(sent.filter(s => s.method === 'GET').length, 0, 'the report was enough; Vapi was not asked');
  assert.equal(ringsTo().length, 2);
});

test('urgent test calls never ring or escalate', async t => {
  const { post, app, sent } = await fixture(t, { env: { TEST_CALLER_NUMBERS: '+16155550100' } });
  await post(toolCall('t-1', { ...intake, is_test: true }));
  await post(toolCall('t-2', intake));
  assert.deepEqual(await app.sweepEscalations(Date.now() + 60 * MIN), []);
  assert.deepEqual(sent, []);
});

test('a hold for a live transfer escalates the released alert call too', async t => {
  const { post, app, ringsTo } = await fixture(t, { routes: { 'client-a': { ...route, transfer: '+15550000777' } }, rings: { 'ring-1': ended('customer-did-not-answer') } });
  await post(toolCall('h-1', intake));
  assert.deepEqual(ringsTo(), []);
  await post(report('h-1', 90));
  assert.deepEqual(ringsTo(), ['+15550000999']);
  assert.deepEqual(await app.sweepEscalations(Date.now() + 3 * MIN), ['escalated']);
  assert.deepEqual(ringsTo(), ['+15550000999', '+15550000888']);
});

test('a caller who hangs up during the greeting becomes a call-back lead, once', async t => {
  const { post, emails, sent } = await fixture(t);
  await post(report('g-1', 3, { recordingUrl: 'https://storage.vapi.ai/g-1.wav' }));
  const lead = emails();
  assert.equal(lead.length, 1);
  assert.equal(lead[0].body.subject, 'Caller hung up during greeting – (615) 555-0100 – call them back');
  assert.match(lead[0].body.text, /^Anchorline AI: Caller hung up - Gold Star Plumbing\nRecording: https:\/\/storage\.vapi\.ai\/g-1\.wav\nUnknown caller - \(615\) 555-0100 \(caller ID\)\nHung up during the greeting/);
  await post(report('g-2', 2));
  assert.equal(emails().length, 1, 'a redial that hangs up again within 30 minutes is the same lead');
  await post(report('g-3', 2, { call: call('g-3', { customer: { number: '+16155550111' } }) }));
  assert.equal(emails().length, 2);
  await post(report('g-4', 2, { call: call('g-4', { assistantId: 'demo-line', customer: { number: '+16155550122' } }) }));
  await post(report('g-5', 2, { call: call('g-5', { customer: {} }) }));
  assert.equal(sent.length, 2, 'no route or no caller ID: nothing to send');
});

test('greeting hang-ups respect test-call rules', async t => {
  const { post, sent } = await fixture(t, { env: { TEST_CALLER_NUMBERS: '+16155550100' } });
  await post(report('gt-1', 3));
  assert.deepEqual(sent, []);
});

test('the recording link of a saved call is kept for the unanswered email', async t => {
  const { post, app, emails } = await fixture(t, { rings: { 'ring-1': ended('customer-did-not-answer') } });
  await post(toolCall('rec-1', intake));
  await post(report('rec-1', 120, { artifact: { recordingUrl: 'https://storage.vapi.ai/rec-1.wav' } }));
  await app.sweepEscalations(Date.now() + 3 * MIN);
  assert.match(emails().find(e => /UNANSWERED/.test(e.body.subject)).body.text, /\nRecording: https:\/\/storage\.vapi\.ai\/rec-1\.wav\n/);
});

// 2026-10-16 07:05 in Chicago (CDT, UTC-5).
const sevenAm = Date.parse('2026-10-16T12:05:00Z');

test('the digest window is yesterday in Chicago, DST included', () => {
  assert.deepEqual(digestWindow(sevenAm), { hour: 7, day: '2026-10-15', label: 'Thursday, October 15', start: '2026-10-15T05:00:00.000Z', end: '2026-10-16T05:00:00.000Z' });
  const fallBack = digestWindow(Date.parse('2026-11-02T13:00:00Z'));
  assert.equal(fallBack.start, '2026-11-01T05:00:00.000Z'); assert.equal(fallBack.end, '2026-11-02T06:00:00.000Z'); assert.equal(fallBack.hour, 7);
  assert.equal(digestWindow(Date.parse('2026-10-16T11:59:00Z')).hour, 6);
});

test('the 7am digest counts yesterday once per route, and opts out with digest: false', async t => {
  const routes = { 'client-a': { ...route, call: [], digest: ['owner@example.com'] }, 'client-b': { business: 'Off Plumbing', email: ['b@example.com'], digest: false } };
  const { post, app, emails } = await fixture(t, { routes });
  await post(toolCall('d-1', intake));
  await post(report('d-1', 120));
  await post(toolCall('d-2', { ...intake, issue: 'Water heater quote', email_status: 'declined' }));
  await post(report('d-2', 200));
  await post(report('d-3', 3, { call: call('d-3', { customer: { number: '+16155550111' } }) }));
  await post(report('d-4', 60, { call: call('d-4', { customer: { number: '+16155550122' } }), artifact: { transcript: 'User: this is a test call' } }));
  const day = Date.now() + 24 * 60 * MIN;
  const { start, end } = digestWindow(day);
  assert.ok(new Date().toISOString() >= start && new Date().toISOString() < end, 'fixture calls land in "yesterday"');
  const hour7 = Date.parse(end) + 7 * 60 * MIN + 1000;
  assert.deepEqual(await app.sendDigests(hour7 - 2 * 60 * MIN), [], 'not before 7am');
  const before = emails().length;
  assert.deepEqual(await app.sendDigests(hour7), ['client-a:accepted']);
  const digest = emails().slice(before);
  assert.equal(digest.length, 1);
  assert.deepEqual(digest[0].body.to, ['office@example.com', 'owner@example.com']);
  assert.equal(digest[0].body.subject, 'Emma yesterday – 3 calls, 2 jobs saved, 1 urgent, 1 hang-up');
  assert.match(digest[0].body.text, /Calls Emma answered: 3\nJobs saved: 2\nUrgent jobs: 1\n- Urgent – Linda Harper – 1412 Dickerson Pike – no alert call placed\nHigh-value jobs: 0\nRoutine jobs: 1\n- Routine – Linda Harper – 1412 Dickerson Pike – Water heater quote\nHang-ups: 1\n- \(615\) 555-0111 \(hung up during greeting\) – call them back/);
  assert.deepEqual(await app.sendDigests(hour7 + 60 * MIN), [], 'once per route per day');
});

test('a zero-call day still gets a digest, once, across a restart', async t => {
  const first = await fixture(t, { routes: { 'client-a': route }, keep: true });
  assert.deepEqual(await first.app.sendDigests(sevenAm), ['client-a:accepted']);
  const zero = first.emails()[0].body;
  assert.equal(zero.subject, 'Emma answered 0 forwarded calls yesterday — she\'s on and working');
  assert.match(zero.text, /^Gold Star Plumbing – Thursday, October 15\n\nCalls Emma answered: 0\nJobs saved: 0\nUrgent jobs: 0\nHigh-value jobs: 0\nRoutine jobs: 0\nHang-ups: 0\n/);
  first.app.closeAllConnections(); await new Promise(resolve => first.app.close(resolve));
  const second = await fixture(t, { routes: { 'client-a': route }, dir: first.dir });
  assert.deepEqual(await second.app.sendDigests(sevenAm + 60 * MIN), []);
});

test('a failed digest is retried 15 minutes later with the same idempotency key', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-retry-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const sent = [];
  let fail = true;
  const send = async (url, init) => { sent.push(init.headers['Idempotency-Key']); return new Response('{}', { status: fail ? 503 : 200 }); };
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ALERT_ROUTES: JSON.stringify({ 'client-a': route }), ...baseEnv }, send);
  t.after(() => new Promise(resolve => app.close(resolve)));
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  assert.deepEqual(await app.sendDigests(sevenAm), ['client-a:needs_review']);
  fail = false;
  assert.deepEqual(await app.sendDigests(sevenAm + 5 * MIN), []);
  assert.deepEqual(await app.sendDigests(sevenAm + 16 * MIN), ['client-a:accepted']);
  assert.deepEqual(await app.sendDigests(sevenAm + 40 * MIN), []);
  assert.deepEqual(sent, ['digest-client-a-2026-10-15', 'digest-client-a-2026-10-15']);
});

test('the digest lists jobs by priority tier: urgent, high-value, routine, save order kept within a tier', () => {
  const job = (name, issue, extra = {}) => ({ details: { name, address: `${name.length} Main St, Nashville`, issue, job_type: '', job_size: '', job_details: '', ...extra } });
  const jobs = [job('Ann Routine', 'Leaky faucet', { job_type: 'Replace a faucet' }), job('Bo Big', 'Whole bathroom', { job_type: 'Bathroom remodel' }),
    { ...job('Cy Urgent', 'URGENT - burst pipe'), ring: 'alert call answered' }, job('Di Routine', 'Toilet runs'),
    job('Ed Big', 'Water heater leaking', { job_size: 'Big job (half day+)' }), { ...job('Flo Urgent', 'URGENT - sewage backing up'), ring: 'put through to you live' }];
  const { subject, text } = digestEmail({ business: 'Gold Star Plumbing' }, 'Thursday, October 15', { calls: 7, jobs, hangups: [] });
  assert.equal(subject, 'Emma yesterday – 7 calls, 6 jobs saved, 2 urgent, 2 high-value');
  assert.match(text, new RegExp(['Jobs saved: 6', 'Urgent jobs: 2', '- Urgent – Cy Urgent – 9 Main St – alert call answered', '- Urgent – Flo Urgent – 10 Main St – put through to you live',
    'High-value jobs: 2', '- High-value – Bo Big – 6 Main St – Bathroom remodel', '- High-value – Ed Big – 6 Main St – Water heater leaking',
    'Routine jobs: 2', '- Routine – Ann Routine – 11 Main St – Replace a faucet', '- Routine – Di Routine – 10 Main St – Toilet runs', 'Hang-ups: 0'].join('\n')));
});

test('a single-tier digest lists only that tier\'s jobs, in save order', () => {
  const job = (name, issue) => ({ details: { name, address: '9 Oak St, Nashville', issue, job_type: '', job_size: '', job_details: '' } });
  const { subject, text } = digestEmail({ business: 'Gold Star Plumbing' }, 'Thursday, October 15',
    { calls: 2, jobs: [job('Ann Cole', 'Leaky faucet'), job('Bo Diaz', 'Toilet runs')], hangups: [] });
  assert.equal(subject, 'Emma yesterday – 2 calls, 2 jobs saved');
  assert.match(text, /Jobs saved: 2\nUrgent jobs: 0\nHigh-value jobs: 0\nRoutine jobs: 2\n- Routine – Ann Cole – 9 Oak St – Leaky faucet\n- Routine – Bo Diaz – 9 Oak St – Toilet runs\nHang-ups: 0\n/);
});

test('an unanswered urgent job whose number was not read back: the email, backup and retry name the caller ID, never as the callback number', async t => {
  const rings = { 'ring-1': ended('customer-did-not-answer', 30), 'ring-2': ended('customer-busy', 0) };
  const { post, app, sent, emails } = await fixture(t, { rings });
  const now = Date.now();
  await post(toolCall('nr-1', { ...intake, callback_phone: '6155550199', callback_read_back: false }));
  assert.deepEqual(await app.sweepEscalations(now + 3 * MIN), ['escalated']);
  const unanswered = emails().filter(e => e.body.subject.startsWith('UNANSWERED URGENT – '));
  assert.equal(unanswered[0].body.subject, 'UNANSWERED URGENT – burst pipe – 1412 Dickerson Pike – (615) 555-0100 (caller ID)');
  assert.match(unanswered[0].body.text, /\nLinda Harper - \(615\) 555-0100 \(caller ID; gave \(615\) 555-0199, not confirmed\)\n/);
  assert.deepEqual(await app.sweepEscalations(now + 6 * MIN), ['retried']);
  const spoken = sent.filter(s => s.url === 'https://api.vapi.ai/call').map(s => s.body.assistant.firstMessage);
  assert.equal(spoken.length, 3);
  for (const text of spoken) {
    assert.match(text, /burst pipe\. They were calling from \(615\) 555-0100\. Their callback number wasn't confirmed, so check your email\./);
    assert.doesNotMatch(text, /Callback number:|555-0199/);
  }
});

test('a confirmed callback number different from the caller ID is the one every ring says', async t => {
  const { post, sent, emails } = await fixture(t);
  await post(toolCall('cf-1', { ...intake, callback_phone: '615-555-0199', callback_read_back: true }));
  const [ring] = sent.filter(s => s.url === 'https://api.vapi.ai/call');
  assert.match(ring.body.assistant.firstMessage, /burst pipe\. Callback number: \(615\) 555-0199\. It's also in your email\./);
  assert.doesNotMatch(ring.body.assistant.firstMessage, /555-0100|calling from/);
  const card = emails().find(e => e.body.to[0] === 'office@example.com');
  assert.equal(card.body.subject, 'URGENT – burst pipe – 1412 Dickerson Pike – (615) 555-0199');
  assert.match(card.body.text, /\nLinda Harper - \(615\) 555-0199 \(confirmed on the call; caller ID \(615\) 555-0100\)\n/);
});
