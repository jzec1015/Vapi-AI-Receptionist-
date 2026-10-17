import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './server.mjs';

// v1.8.1: a request whose office alert reached nobody (every channel failed) is retried, then Anchorline is told.
const key = 'synthetic-test-key-not-used-in-production';
const MIN = 60000;
const route = { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'] };
const alertEnv = { ALERT_ROUTES: JSON.stringify({ 'client-a': route }), TELNYX_API_KEY: 'fixture-only', TELNYX_FROM: '+15550000000',
  RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com', OFFICE_EMAIL: 'ops@example.com' };
const intake = { name: 'Linda Harper', address: '48 Birch Road', issue: 'Slow kitchen drain', is_test: false, callback_phone: '6155550142',
  email_status: 'declined' };
const toolCall = (id, args = intake) => ({ message: { type: 'tool-calls', call: { id, assistantId: 'client-a', customer: { number: '+16155550100' } },
  toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } });
const hangup = id => ({ message: { type: 'end-of-call-report', durationSeconds: 45, analysis: { summary: 'Caller reported a leak and hung up.' },
  call: { id, assistantId: 'client-a', type: 'inboundPhoneCall', customer: { number: '+16155550100' } } } });
const result = async response => JSON.parse((await response.json()).results[0].result);

// down: providers that answer 500 ('telnyx', 'resend' = client alert email, 'office' = mail to OFFICE_EMAIL, 'vapi').
// gate: when set, every send waits for it (an alert still in flight). keep: the test closes the app itself.
async function fixture(t, { dir = mkdtempSync(join(tmpdir(), 'office-retry-')), keep = false, env = {} } = {}) {
  const sent = [], down = new Set(), state = { gate: null };
  const send = async (url, init) => {
    const body = JSON.parse(init.body);
    const provider = url.includes('telnyx') ? 'telnyx' : url.includes('vapi') ? 'vapi' : body.to?.includes?.('ops@example.com') ? 'office' : 'resend';
    if (state.gate) await state.gate;
    sent.push({ provider, body, key: init.headers['Idempotency-Key'] });
    return new Response(JSON.stringify({ id: `vapi-${sent.length}` }), { status: down.has(provider) ? 500 : 200 });
  };
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ...alertEnv, ...env }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  if (!keep) t.after(async () => { await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = async body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) });
  const rows = () => { const db = new DatabaseSync(join(dir, 'requests.sqlite')); try { return db.prepare('SELECT * FROM office_retries ORDER BY call_id').all(); } finally { db.close(); } };
  const close = () => new Promise(resolve => app.close(resolve));
  return { app, post, sent, down, dir, rows, state, close };
}
const quiet = t => { const { log, warn, error } = console; console.log = console.warn = console.error = () => {}; t.after(() => Object.assign(console, { log, warn, error })); };

test('an alert that reached nobody is retried every minute until a channel gets through, with the same email key', async t => {
  quiet(t);
  const { app, post, sent, down, rows } = await fixture(t);
  down.add('telnyx'); down.add('resend');
  const saved = await result(await post(toolCall('all-down')));
  assert.equal(saved.saved, true); assert.equal(saved.office_alert, 'needs_review');
  const firstKey = sent.find(s => s.provider === 'resend').key;
  const now = Date.now();
  assert.deepEqual(await app.sweepOfficeRetries(now + 30000), [], 'not before a minute');
  assert.deepEqual(await app.sweepOfficeRetries(now + MIN + 1000), ['retrying']);
  down.clear();
  const before = sent.length;
  assert.deepEqual(await app.sweepOfficeRetries(now + 2 * MIN + 2000), ['sent']);
  const retry = sent.slice(before);
  assert.equal(retry.filter(s => s.provider === 'telnyx').length, 1);
  assert.deepEqual(retry.filter(s => s.provider === 'resend').map(s => s.key), [firstKey], 'Resend can dedupe a send that did land');
  assert.deepEqual(await app.sweepOfficeRetries(now + 10 * MIN), [], 'done once delivered');
  assert.equal(rows()[0].done, 'sent');
  assert.equal((await result(await post(toolCall('all-down')))).office_alert, 'sent_after_retry', 'a repeat of the call sees the real outcome');
});

test('the retry is armed before the alert goes out, so a crash mid-alert still retries after a restart', async t => {
  quiet(t);
  const first = await fixture(t, { keep: true });
  let release; first.state.gate = new Promise(resolve => { release = resolve; });
  const pending = first.post(toolCall('crash-mid-alert'));
  for (let i = 0; i < 100 && !first.rows().length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(first.rows().map(r => [r.call_id, r.done, r.attempts]), [['crash-mid-alert', null, 0]], 'armed while the alert is still in flight');
  // The "crash": a second server on the same data folder takes over while the first alert never finished.
  const second = await fixture(t, { dir: first.dir });
  assert.deepEqual(await second.app.sweepOfficeRetries(Date.now() + MIN + 1000), ['sent']);
  assert.equal(second.sent.filter(s => s.provider === 'telnyx').length, 1);
  release(); await pending; await first.close();
});

test('a delivered or partly delivered alert closes its retry and is never sent again', async t => {
  quiet(t);
  const { app, post, sent, down, rows } = await fixture(t);
  await post(toolCall('all-up'));
  down.add('telnyx');
  assert.equal((await result(await post(toolCall('half-down')))).office_alert, 'needs_review');
  assert.deepEqual(rows().map(r => [r.call_id, r.done]), [['all-up', 'sent'], ['half-down', 'needs_review']]);
  const before = sent.length;
  assert.deepEqual(await app.sweepOfficeRetries(Date.now() + 10 * MIN), []);
  assert.equal(sent.length, before);
});

test('an urgent ring that was placed counts as reaching the office', async t => {
  quiet(t);
  const urgentEnv = { VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'phone-1', ALERT_ROUTES: JSON.stringify({ 'client-a': { ...route, call: ['+15550000009'] } }) };
  const { post, down, rows } = await fixture(t, { env: urgentEnv });
  down.add('telnyx'); down.add('resend');
  const saved = await result(await post(toolCall('urgent-ring', { ...intake, issue: 'URGENT - burst pipe' })));
  assert.equal(saved.office_alert, 'needs_review');
  assert.equal(rows()[0].done, 'needs_review', 'closed: the owner is being rung (escalation handles an unanswered ring)');
});

test('urgent ring placed and answered while SMS and email failed: no Anchorline give-up email, no re-texts', async t => {
  quiet(t);
  const urgentEnv = { VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'phone-1', ALERT_ROUTES: JSON.stringify({ 'client-a': { ...route, call: ['+15550000009'] } }) };
  const { app, post, sent, down, rows } = await fixture(t, { env: urgentEnv });
  down.add('telnyx'); down.add('resend');
  const saved = await result(await post(toolCall('urgent-answered', { ...intake, issue: 'URGENT - burst pipe' })));
  assert.equal(saved.saved, true);
  const ring = sent.find(s => s.provider === 'vapi');
  assert.ok(ring, 'the owner was rung');
  // The alert call's own end-of-call report: the owner heard it.
  const vapiId = `vapi-${sent.indexOf(ring) + 1}`;
  assert.equal((await post({ message: { type: 'end-of-call-report', endedReason: 'assistant-ended-call', durationSeconds: 40,
    call: { id: vapiId, type: 'outboundPhoneCall' } } })).status, 200);
  const smsTries = sent.filter(s => s.provider === 'telnyx').length;
  const start = Date.now();
  for (let now = start + 30000; now < start + 2 * 60 * MIN; now += 5 * MIN)
    await Promise.all([app.sweepOutbox(now), app.sweepOfficeRetries(now), app.sweepEscalations(now)]);
  assert.equal(rows()[0].done, 'needs_review', 'the office retry was closed by the ring');
  const toAnchorline = sent.filter(s => s.provider === 'office' && /Office alert failed|ALERT NOT DELIVERED|UNANSWERED/.test(s.body.subject));
  assert.deepEqual(toAnchorline, [], 'nothing claims the office was not reached');
  assert.equal(sent.filter(s => s.provider === 'telnyx').length, smsTries, 'no re-texts');
  assert.equal(sent.filter(s => s.provider === 'vapi').length, 1, 'answered: no backup or second ring');
});

test('after 5 failed retries Anchorline is told once, and that notice is retried until accepted', async t => {
  quiet(t);
  const { app, post, sent, down, rows } = await fixture(t);
  down.add('telnyx'); down.add('resend'); down.add('office');
  await post(toolCall('never'));
  const now = Date.now();
  for (let i = 1; i <= 5; i++) assert.deepEqual(await app.sweepOfficeRetries(now + i * 61000), ['retrying']);
  const smsTries = sent.filter(s => s.provider === 'telnyx').length;
  assert.equal(smsTries, 6, 'the first try plus 5 retries');
  assert.deepEqual(await app.sweepOfficeRetries(now + 6 * 61000), ['gave_up_needs_review']);
  down.delete('office');
  assert.deepEqual(await app.sweepOfficeRetries(now + 7 * 61000), ['gave_up_accepted']);
  const notices = sent.filter(s => s.provider === 'office' && /^Office alert failed/.test(s.body.subject));
  assert.equal(notices.length, 2);
  assert.equal(new Set(notices.map(s => s.key)).size, 1, 'one Idempotency-Key: Resend sends it at most once');
  assert.match(notices[1].body.text, /^Every alert channel failed 6 times[\s\S]*Nobody at the office has been told[\s\S]*Request reference: /);
  assert.equal(sent.filter(s => s.provider === 'telnyx').length, smsTries, 'no more client texts once given up');
  assert.equal(rows()[0].done, 'gave_up_notice_accepted');
  assert.deepEqual(await app.sweepOfficeRetries(now + 60 * MIN), []);
});

test('the Anchorline notice gives up after an hour of failures', async t => {
  quiet(t);
  const { app, post, down, rows } = await fixture(t);
  down.add('telnyx'); down.add('resend'); down.add('office');
  await post(toolCall('silent'));
  const now = Date.now();
  for (let i = 1; i <= 70 && !rows()[0].done; i++) await app.sweepOfficeRetries(now + i * 61000);
  assert.equal(rows()[0].done, 'gave_up_silent'); assert.equal(rows()[0].attempts, 65);
});

test('without OFFICE_EMAIL the retry still ends after 5 tries', async t => {
  quiet(t);
  const { app, post, down, rows } = await fixture(t, { env: { OFFICE_EMAIL: '' } });
  down.add('telnyx'); down.add('resend');
  await post(toolCall('no-office'));
  const now = Date.now();
  for (let i = 1; i <= 6; i++) await app.sweepOfficeRetries(now + i * 61000);
  assert.equal(rows()[0].done, 'gave_up_notice_not_requested');
});

test('a route that disappears mid-retry still ends in the Anchorline notice', async t => {
  quiet(t);
  const first = await fixture(t, { keep: true });
  first.down.add('telnyx'); first.down.add('resend');
  await first.post(toolCall('route-gone'));
  await first.close();
  const second = await fixture(t, { dir: first.dir, env: { ALERT_ROUTES: '{}' } });
  assert.deepEqual(await second.app.sweepOfficeRetries(Date.now() + MIN + 1000), ['gave_up_accepted']);
  const notice = second.sent.find(s => s.provider === 'office');
  assert.match(notice.body.text, /alert route is gone[\s\S]*Issue: Slow kitchen drain/);
  assert.equal(second.sent.filter(s => s.provider === 'telnyx').length, 0);
});

test('a retry that throws is counted, so it still reaches the cap', async t => {
  quiet(t);
  const { app, post, down, dir, rows } = await fixture(t);
  down.add('telnyx'); down.add('resend');
  await post(toolCall('broken-row'));
  const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  db.prepare("UPDATE requests SET details = '{' WHERE call_id = 'broken-row'").run(); db.close();
  assert.deepEqual(await app.sweepOfficeRetries(Date.now() + MIN + 1000), ['error']);
  assert.equal(rows()[0].attempts, 1);
  assert.deepEqual(await app.sweepOfficeRetries(Date.now() + MIN + 2000), [], 'waits a minute, not 5 s');
});

test('a retry that keeps throwing ends in an Anchorline notice by call ID', async t => {
  quiet(t);
  const { app, post, sent, down, dir, rows } = await fixture(t);
  down.add('telnyx'); down.add('resend');
  await post(toolCall('always-broken'));
  const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  db.prepare("UPDATE requests SET details = '{' WHERE call_id = 'always-broken'").run(); db.close();
  const now = Date.now();
  for (let i = 1; i <= 6; i++) assert.deepEqual(await app.sweepOfficeRetries(now + i * 61000), ['error']);
  assert.equal(rows()[0].done, 'gave_up_error_notice_accepted');
  assert.match(sent.find(s => s.provider === 'office' && /could not be read/.test(s.body.subject)).body.text, /Vapi call ID: always-broken/);
});

test('test calls and lines without a route are never queued, even when the route alerts on tests', async t => {
  quiet(t);
  const { app, post, down, rows } = await fixture(t, { env: { ALERT_ROUTES: JSON.stringify({ 'client-a': { ...route, alertTests: true } }) } });
  down.add('telnyx'); down.add('resend');
  assert.equal((await result(await post(toolCall('test-call', { ...intake, is_test: true })))).office_alert, 'needs_review');
  const other = toolCall('no-route'); other.message.call.assistantId = 'demo-line';
  assert.equal((await result(await post(other))).office_alert, 'not_configured');
  assert.deepEqual(rows(), [], 'neither the test call nor a line without a route is armed');
  assert.deepEqual(await app.sweepOfficeRetries(Date.now() + 10 * MIN), []);
});

test('a hang-up alert that reached nobody is retried too', async t => {
  quiet(t);
  const { app, post, sent, down } = await fixture(t);
  down.add('telnyx'); down.add('resend');
  assert.equal((await post(hangup('hang-down'))).status, 200);
  down.clear();
  const before = sent.length;
  assert.deepEqual(await app.sweepOfficeRetries(Date.now() + MIN + 1000), ['sent']);
  assert.match(sent.slice(before).find(s => s.provider === 'telnyx').body.text, /^Anchorline AI: Caller hung up - Gold Star Plumbing/);
});

test('failed alert emails and every submit outcome are logged without caller details', async t => {
  const { post, down } = await fixture(t);
  const lines = [];
  const { log, warn } = console;
  console.log = (...a) => lines.push(a.join(' ')); console.warn = (...a) => lines.push(a.join(' '));
  t.after(() => { console.log = log; console.warn = warn; });
  down.add('telnyx'); down.add('resend');
  await post(toolCall('log-call'));
  console.log = log; console.warn = warn;
  const text = lines.join('\n');
  assert.match(text, /alert email failed: HTTP 500 request=/);
  assert.match(text, /submit call=log-call request=\S+ urgent=no office_alert=needs_review caller_email=not_requested anchorline_email=\S+ retry=queued/);
  assert.match(text, /office-alert reached nobody call=log-call/);
  assert.doesNotMatch(text, /Linda|Harper|Birch|6155550142|555-0142|kitchen/i);
});
