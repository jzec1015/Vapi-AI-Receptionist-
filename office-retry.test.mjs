import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from './server.mjs';

// v1.8.1: a request whose office alert reached nobody (every channel failed) is retried, then Anchorline is told.
const key = 'synthetic-test-key-not-used-in-production';
const MIN = 60000;
const routes = JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'] } });
const alertEnv = { ALERT_ROUTES: routes, TELNYX_API_KEY: 'fixture-only', TELNYX_FROM: '+15550000000', RESEND_API_KEY: 'fixture-only',
  EMAIL_FROM: 'alerts@example.com', OFFICE_EMAIL: 'ops@example.com' };
const intake = { name: 'Linda Harper', address: '48 Birch Road', issue: 'Slow kitchen drain', is_test: false, callback_phone: '6155550142',
  email_status: 'declined' };
const toolCall = (id, args = intake) => ({ message: { type: 'tool-calls', call: { id, assistantId: 'client-a', customer: { number: '+16155550100' } },
  toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } });
const hangup = id => ({ message: { type: 'end-of-call-report', durationSeconds: 45, analysis: { summary: 'Caller reported a leak and hung up.' },
  call: { id, assistantId: 'client-a', type: 'inboundPhoneCall', customer: { number: '+16155550100' } } } });
const result = async response => JSON.parse((await response.json()).results[0].result);

// down: providers that fail ('telnyx', 'resend', 'office' = the Anchorline notice). Every send is recorded.
async function fixture(t, { dir = mkdtempSync(join(tmpdir(), 'office-retry-')), keep = false } = {}) {
  const sent = [], down = new Set();
  const send = async (url, init) => {
    const body = JSON.parse(init.body);
    const provider = url.includes('telnyx') ? 'telnyx' : body.to?.includes?.('ops@example.com') ? 'office' : 'resend';
    sent.push({ provider, body, key: init.headers['Idempotency-Key'] });
    return new Response('{}', { status: down.has(provider) ? 500 : 200 });
  };
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ...alertEnv }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  // keep: the test closes this app itself (to restart on the same folder) and the next fixture removes the folder.
  if (!keep) t.after(async () => { await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = async body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) });
  const alerts = () => sent.filter(s => s.provider !== 'office' && !(s.body.to || []).includes?.('ops@example.com'));
  return { app, post, sent, down, dir, alerts };
}

test('an alert that reached nobody is retried every minute until a channel gets through, with the same email key', async t => {
  const { app, post, sent, down } = await fixture(t);
  down.add('telnyx'); down.add('resend');
  const saved = await result(await post(toolCall('all-down')));
  assert.equal(saved.saved, true); assert.equal(saved.office_alert, 'needs_review');
  const firstKey = sent.find(s => s.provider === 'resend' && s.body.to?.[0] === 'office@example.com').key;
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
  const again = await result(await post(toolCall('all-down')));
  assert.equal(again.office_alert, 'sent_after_retry', 'a repeat of the call sees the real outcome');
});

test('a partly delivered alert is not retried (no second text or email)', async t => {
  const { app, post, sent, down } = await fixture(t);
  down.add('telnyx');
  assert.equal((await result(await post(toolCall('half-down')))).office_alert, 'needs_review');
  const before = sent.length;
  assert.deepEqual(await app.sweepOfficeRetries(Date.now() + 10 * MIN), []);
  assert.equal(sent.length, before);
});

test('after 5 failed retries Anchorline is told once, and that notice is retried until accepted', async t => {
  const { app, post, sent, down } = await fixture(t);
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
  assert.match(notices[1].body.text, /Nobody at the office has been told[\s\S]*Request reference: /);
  assert.equal(sent.filter(s => s.provider === 'telnyx').length, smsTries, 'no more client texts once given up');
  assert.deepEqual(await app.sweepOfficeRetries(now + 60 * MIN), []);
});

test('test calls and lines without a route are never queued', async t => {
  const { app, post, down } = await fixture(t);
  down.add('telnyx'); down.add('resend');
  assert.equal((await result(await post(toolCall('test-call', { ...intake, is_test: true })))).office_alert, 'suppressed_test');
  const other = toolCall('no-route'); other.message.call.assistantId = 'demo-line';
  assert.equal((await result(await post(other))).office_alert, 'not_configured');
  assert.deepEqual(await app.sweepOfficeRetries(Date.now() + 10 * MIN), []);
});

test('a hang-up alert that reached nobody is retried too', async t => {
  const { app, post, sent, down } = await fixture(t);
  down.add('telnyx'); down.add('resend');
  assert.equal((await post(hangup('hang-down'))).status, 200);
  down.clear();
  const before = sent.length;
  assert.deepEqual(await app.sweepOfficeRetries(Date.now() + MIN + 1000), ['sent']);
  assert.match(sent.slice(before).find(s => s.provider === 'telnyx').body.text, /^Anchorline AI: Caller hung up - Gold Star Plumbing/);
});

test('a queued retry survives a restart', async t => {
  const first = await fixture(t, { keep: true });
  first.down.add('telnyx'); first.down.add('resend');
  await first.post(toolCall('restart-down'));
  await new Promise(resolve => first.app.close(resolve));
  const second = await fixture(t, { dir: first.dir });
  assert.deepEqual(await second.app.sweepOfficeRetries(Date.now() + MIN + 1000), ['sent']);
  assert.equal(second.sent.filter(s => s.provider === 'telnyx').length, 1);
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
