import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp, testReason } from './server.mjs';

const key = 'synthetic-test-key-not-used-in-production';
const routes = JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'] } });
const baseEnv = { VAPI_WEBHOOK_SECRET: key, ALERT_ROUTES: routes, TELNYX_API_KEY: 'fixture-only', TELNYX_FROM: '+15550000000',
  RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com', OFFICE_EMAIL: 'anchorline@example.com',
  TEST_CALLER_NUMBERS: '+1 (555) 000-7777, 5550008888', TEST_ASSISTANT_IDS: 'demo-assistant' };
const intake = { name: 'Synthetic Caller', address: '1 Fixture Lane', issue: 'Running toilet', is_test: false, callback_phone: '5550001234',
  email: 'caller@example.com', email_confirmed: true, email_status: 'confirmed' };
const toolCall = (id, args, call = {}) => ({ message: { type: 'tool-calls', call: { id, assistantId: 'client-a', customer: { number: '+15550001111' }, ...call },
  toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } });

async function fixture(t, { dir = mkdtempSync(join(tmpdir(), 'testdata-')), env = {} } = {}) {
  const sent = [];
  const send = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  const app = createApp({ DATA_DIR: dir, ...baseEnv, ...env }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = async body => fetch(base + '/vapi/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) });
  const rows = () => { const db = new DatabaseSync(join(dir, 'requests.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT call_id, assistant_id, is_test, details FROM requests ORDER BY call_id').all(); } finally { db.close(); } };
  return { base, post, sent, rows, dir };
}
const result = async response => JSON.parse((await response.json()).results[0].result);

test('testReason classifies explicit, chat, test assistant and test numbers; live calls stay live', () => {
  const env = { TEST_CALLER_NUMBERS: '+17205550100, (615) 555-0199', TEST_ASSISTANT_IDS: 'demo' };
  assert.equal(testReason(env, { explicit: true }), 'explicit');
  assert.equal(testReason(env, { callId: 'session:abc' }), 'chat');
  assert.equal(testReason(env, { callId: 'chat:abc' }), 'chat');
  assert.equal(testReason(env, { callId: 'voice', assistantId: 'demo' }), 'test_assistant');
  assert.equal(testReason(env, { callId: 'voice', callerId: '+1 720 555 0100' }), 'test_number');
  assert.equal(testReason(env, { callId: 'voice', callbackPhone: '6155550199' }), 'test_number');
  assert.equal(testReason(env, { callId: 'voice', assistantId: 'client', callerId: '+16155550123', callbackPhone: '6155550123' }), null);
  assert.equal(testReason({}, { callId: 'voice', callerId: '' }), null);
});

test('a call from a listed test number is stored as a test and alerts or emails no one', async t => {
  const { post, sent, rows } = await fixture(t);
  const saved = await result(await post(toolCall('call-jake', intake, { customer: { number: '+15550007777' } })));
  assert.equal(saved.saved, true);
  assert.equal(saved.office_alert, 'suppressed_test');
  assert.equal(saved.caller_email, 'suppressed_test');
  assert.equal(saved.anchorline_email, 'suppressed_test');
  assert.equal(sent.length, 0);
  const [row] = rows();
  assert.equal(row.is_test, 1); assert.equal(row.assistant_id, 'client-a');
  assert.equal(JSON.parse(row.details).test_reason, 'test_number');
});

test('requests on a test assistant or dashboard chat are tests; a real caller still alerts the client', async t => {
  const { post, sent, rows } = await fixture(t);
  const demo = await result(await post(toolCall('call-demo', intake, { assistantId: 'demo-assistant' })));
  assert.equal(demo.caller_email, 'suppressed_test');
  const chat = toolCall('unused', intake); delete chat.message.call; chat.message.chat = { id: 'turn-1', sessionId: 's-1', assistantId: 'client-a' };
  assert.equal((await result(await post(chat))).office_alert, 'suppressed_test');
  assert.equal(sent.length, 0);
  const live = await result(await post(toolCall('call-live', intake)));
  assert.equal(live.office_alert, 'sent'); assert.equal(live.caller_email, 'accepted');
  assert.ok(sent.length > 0);
  assert.deepEqual(rows().map(r => [r.call_id, r.assistant_id, r.is_test]),
    [['call-demo', 'demo-assistant', 1], ['call-live', 'client-a', 0], ['session:s-1', 'client-a', 1]]);
});

test('a hang-up from a listed test number is flagged as a test and never alerts', async t => {
  const { post, sent, rows } = await fixture(t);
  const res = await post({ message: { type: 'end-of-call-report', durationSeconds: 40, summary: 'Caller asked about a leak',
    call: { id: 'hang-1', assistantId: 'client-a', customer: { number: '5550008888' } } } });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 0);
  const [row] = rows();
  assert.equal(row.is_test, 1); assert.equal(JSON.parse(row.details).test_reason, 'test_number');
});

test('admin summary needs the key and returns counts by assistant without caller details', async t => {
  const { base, post } = await fixture(t);
  await post(toolCall('call-live', intake));
  await post(toolCall('call-test', { ...intake, is_test: true }));
  await post(toolCall('call-demo', intake, { assistantId: 'demo-assistant' }));
  assert.equal((await fetch(base + '/admin/requests/summary')).status, 401);
  assert.equal((await fetch(base + '/admin/requests/summary', { method: 'POST', headers: { 'x-anchorline-key': key } })).status, 405);
  const response = await fetch(base + '/admin/requests/summary', { headers: { 'x-anchorline-key': key } });
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.total, 3); assert.equal(body.live, 1); assert.equal(body.test, 2);
  assert.deepEqual(body.by_assistant.map(g => [g.assistant_id, g.is_test, g.n]), [['client-a', false, 1], ['client-a', true, 1], ['demo-assistant', true, 1]]);
  for (const secret of ['Synthetic Caller', 'Fixture Lane', '5550001234', 'caller@example.com']) assert.ok(!text.includes(secret), `summary leaked ${secret}`);
});

test('an existing v1.5 database is migrated in place: rows kept, test rows backfilled', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'testdata-migrate-'));
  const old = new DatabaseSync(join(dir, 'requests.sqlite'));
  old.exec(`CREATE TABLE requests (call_id TEXT PRIMARY KEY, id TEXT NOT NULL, created_at TEXT NOT NULL, details TEXT NOT NULL, result TEXT NOT NULL)`);
  const add = old.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)');
  add.run('old-live', 'id-1', '2026-10-01T00:00:00Z', JSON.stringify({ is_test: false }), '{}');
  add.run('old-test', 'id-2', '2026-10-01T00:00:00Z', JSON.stringify({ is_test: true }), '{}');
  add.run('session:old-chat', 'id-3', '2026-10-01T00:00:00Z', JSON.stringify({ is_test: false }), '{}');
  old.close();
  const { rows, post } = await fixture(t, { dir });
  assert.deepEqual(rows().map(r => [r.call_id, r.is_test, r.assistant_id]),
    [['old-live', 0, null], ['old-test', 1, null], ['session:old-chat', 1, null]]);
  const dup = await result(await post(toolCall('old-live', intake)));
  assert.equal(dup.duplicate, true);
});
