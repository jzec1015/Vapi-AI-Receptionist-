import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from './server.mjs';
import { createApp as createV150 } from './fixtures/server-v1.5.0.mjs';

// Production on 2026-10-14 has exactly these variables (values here are fixtures): no OFFICE_EMAIL, no BOOKING_ROUTES,
// no TEST_* lists and no "transfer" on any route. With them, v1.6 must do what v1.5.0 (main) does for every kind of
// call: same requests to Resend, Telnyx and Vapi, same recipients, same spoken alert, same caller email, same tool
// results. Only the office alert wording may differ (brand prefix, GSM-7 text, no opt-out line in emails).
const emma = 'assistant-emma';
const prodEnv = {
  ALERT_CALL_FROM_ID: 'phone-number-id-alerts',
  ALERT_ROUTES: JSON.stringify({ [emma]: { business: 'Gold Star Plumbing', email: ['owner@example.com'], sms: ['+15550000001'], call: ['+15550000999'] } }),
  ALERT_ROUTES_GOLD_STAR_LIVE: JSON.stringify({ [emma]: { business: 'Gold Star Plumbing', email: ['tammy@example.com'] } }),
  EMAIL_FROM: 'no-reply@example.com', RESEND_API_KEY: 'fixture-resend', TELNYX_API_KEY: 'fixture-telnyx', TELNYX_FROM: '+15550000000',
  VAPI_API_KEY: 'fixture-vapi', VAPI_WEBHOOK_SECRET: 'synthetic-test-key-not-used-in-production'
};
const call = (id, extra = {}) => ({ id, assistantId: emma, type: 'inboundPhoneCall', customer: { number: '+16155550100' }, ...extra });
const tool = (id, name, args) => ({ message: { type: 'tool-calls', call: call(id), toolCallList: [{ id: 'tool-1', function: { name, arguments: args } }] } });
const report = (id, durationSeconds, extra = {}) => ({ message: { type: 'end-of-call-report', durationSeconds, endedReason: 'customer-ended-call', call: call(id),
  analysis: { summary: 'Caller reported a leak and hung up.' }, ...extra } });
const routine = { name: 'Linda Harper', address: '48 Birch Road', issue: 'Kitchen faucet dripping', is_test: false, callback_phone: '6155550142', callback_read_back: true,
  email: 'linda@example.com', email_confirmed: true, email_status: 'confirmed', preferred_time: 'Tuesday morning', job_type: 'Repair', job_size: 'Quick' };
const urgent = { name: 'Linda Harper', address: '48 Birch Road', issue: 'URGENT - water spraying under kitchen sink', is_test: false,
  callback_phone: '6155550142', callback_read_back: true, email_status: 'skipped_emergency' };

const scenarios = {
  'normal call': [tool('n-1', 'submit_service_request', routine), tool('n-1', 'submit_service_request', routine), report('n-1', 120)],
  'urgent call': [tool('u-1', 'submit_service_request', urgent), tool('u-1', 'add_request_note', { note: 'Main shut-off is in the garage' }), report('u-1', 150)],
  'hang-up': [report('h-1', 45), report('h-1', 45), report('h-short', 4), report('h-noid', 30, { call: call('h-noid', { customer: {} }) })],
  'late email': [tool('l-1', 'submit_service_request', urgent),
    tool('l-1', 'add_customer_email', { email: 'linda@example.com', confirmed_after_spelling_back: false }),
    tool('l-1', 'add_customer_email', { email: 'linda@example.com', confirmed_after_spelling_back: true }), report('l-1', 200)],
  'test call': [tool('t-1', 'submit_service_request', { ...routine, is_test: true }),
    tool('t-2', 'submit_service_request', { ...urgent, is_test: true }), tool('t-2', 'add_request_note', { note: 'test note' }),
    tool('t-2', 'add_customer_email', { email: 'jake@example.com', confirmed_after_spelling_back: true }), report('t-2', 90),
    report('t-3', 40, { artifact: { transcript: 'User: Hi, this is a test call. AI: Thanks.' } })]
};

async function run(t, factory, steps) {
  const dir = mkdtempSync(join(tmpdir(), 'parity-'));
  const sent = [];
  const send = async (url, init) => { sent.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    return new Response('{}', { status: 200 }); };
  const app = factory({ DATA_DIR: dir, ...prodEnv }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); if (app.listening) await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const replies = [];
  for (const body of steps) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': prodEnv.VAPI_WEBHOOK_SECRET }, body: JSON.stringify(body) });
    const json = await response.json();
    replies.push({ status: response.status, json: json.results ? json.results.map(r => JSON.parse(r.result)) : json });
  }
  if (app.sweepTransfers) await app.sweepTransfers(Date.now() + 3600000);
  // Request IDs are random UUIDs; replace each with its order of appearance.
  const ids = [];
  const text = JSON.stringify({ replies, sent }).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<=Reference: )[0-9a-f]{8}/g, m => {
    const i = ids.findIndex(x => x.startsWith(m) || m.startsWith(x)); if (i >= 0) return `ID${i}`; ids.push(m); return `ID${ids.length - 1}`; });
  return JSON.parse(text);
}
// The alert-callback change asks for "the number", and never to call a number the callback number unless the alert does.
const CALLBACK_RULE = [' especially the number. Never call a number the callback number unless the alert above does.', ' especially the callback number.'];
const callbackRule = s => s.url === 'https://api.vapi.ai/call' ? JSON.parse(JSON.stringify(s).replace(...CALLBACK_RULE)) : s;
const isAlert = s => (s.url.includes('telnyx')) || (s.url.includes('resend') && s.headers['Idempotency-Key'].includes('-alert-'));
// Office alert wording is allowed to differ; who gets what, from whom, and with which idempotency key may not.
// v1.8 adds one sentence to the spoken alert's system prompt (never end a voicemail; ending the call now means "heard").
const V18_VOICEMAIL = ' If you only hear a voicemail greeting, a beep or a recording, never end the call yourself; just wait.';
const spoken = s => s.url === 'https://api.vapi.ai/call' ? JSON.parse(JSON.stringify(s).replace(V18_VOICEMAIL, '')) : s;
// v1.8.1 keys a note alert's email by its tool call (<id>-alert-note-<hash>) instead of the note count, so a Vapi retry is one email.
const noteKey = headers => headers?.['Idempotency-Key']?.includes('-alert-note-')
  ? { ...headers, 'Idempotency-Key': headers['Idempotency-Key'].replace(/-alert-note-(\d+|[0-9a-f]{32})$/, '-alert-note-<key>') } : headers;
// The note-fail-line change adds say and note to every saved:false add_request_note / add_customer_email result (every other field unchanged).
const NOTE_TOOLS = new Set(['add_request_note', 'add_customer_email']);
const withoutSayLine = (steps, replies) => replies.map((reply, i) => {
  const name = steps[i].message?.toolCallList?.[0]?.function?.name;
  if (!NOTE_TOOLS.has(name) || !reply.json.map) return reply;
  return { ...reply, json: reply.json.map(r => {
    if (r.saved !== false) return r;
    assert.equal(r.say, 'Mention that when the team calls you, so they have it.'); assert.match(r.note, /^NOT saved/);
    const { say, note, ...rest } = r; return rest;
  }) };
});
const shape = s => isAlert(s) ? { url: s.url, method: s.method, headers: noteKey(s.headers), to: s.body.to, from: s.body.from } : spoken(s);

for (const [name, steps] of Object.entries(scenarios)) {
  test(`with today's production variables, a ${name} does what v1.5.0 does`, async t => {
    const before = await run(t, createV150, steps);
    const after = await run(t, createApp, steps);
    assert.ok(name === 'test call' || before.sent.length > 0, "scenario sends something");
    assert.deepEqual(withoutSayLine(steps, after.replies), before.replies);
    assert.deepEqual(after.sent.map(callbackRule).map(shape), before.sent.map(shape));
    assert.ok(!after.sent.some(s => s.method === 'GET'), 'no Vapi call lookups without a transfer route');
  });
}

test('the scenarios exercise every outbound channel, and test calls send nothing', async t => {
  const all = await run(t, createApp, Object.values(scenarios).slice(0, 4).flat());
  const urls = new Set(all.sent.map(s => s.url));
  for (const u of ['https://api.resend.com/emails', 'https://api.telnyx.com/v2/messages', 'https://api.vapi.ai/call']) assert.ok(urls.has(u), u);
  assert.equal(all.sent.filter(s => s.url === 'https://api.vapi.ai/call').length, 2, 'one spoken alert per urgent call');
  const tests = await run(t, createApp, scenarios['test call']);
  assert.deepEqual(tests.sent, []);
});
