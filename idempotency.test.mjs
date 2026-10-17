import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './server.mjs';

// Vapi retries a tool call (server.backoffPlan) with the same body: same toolCall id, same arguments.
const key = 'synthetic-test-key-not-used-in-production';
const routes = JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'] } });
const alertEnv = { ALERT_ROUTES: routes, TELNYX_API_KEY: 'fixture-only', TELNYX_FROM: '+15550000000', RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com' };
const intake = { name: 'Linda Harper', address: '48 Birch Road', issue: 'Slow drain in the kitchen', is_test: false, callback_phone: '6155550142', email_status: 'declined' };
const toolCall = (id, name, args, toolId = 'tool-1') => ({ message: { type: 'tool-calls', call: { id, assistantId: 'client-a', customer: { number: '+16155550100' } },
  toolCallList: [{ id: toolId, function: { name, arguments: args } }] } });
async function fixture(t, delayMs = 0) {
  const sent = [];
  const send = async (url, init) => {
    sent.push({ url, key: init.headers?.['Idempotency-Key'], body: JSON.parse(init.body) });
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    return new Response('{}', { status: 200 });
  };
  const dir = mkdtempSync(join(tmpdir(), 'idem-test-'));
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ...alertEnv }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = async body => JSON.parse((await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key },
    body: JSON.stringify(body) })).json()).results[0].result);
  const saved = callId => { const db = new DatabaseSync(join(dir, 'requests.sqlite')); try { return JSON.parse(db.prepare('SELECT details FROM requests WHERE call_id = ?').get(callId).details); } finally { db.close(); } };
  const sms = () => sent.filter(s => s.url.includes('telnyx'));
  const emails = () => sent.filter(s => s.url.includes('resend'));
  return { post, sent, saved, sms, emails };
}

test('a retried add_request_note (same toolCall id) appends once and alerts once', async t => {
  const { post, saved, sms, emails } = await fixture(t);
  await post(toolCall('n-1', 'submit_service_request', intake, 'tc-submit'));
  const [smsBefore, emailsBefore] = [sms().length, emails().length];
  const first = await post(toolCall('n-1', 'add_request_note', { note: 'Gate code 4471' }, 'tc-note-1'));
  const retry = await post(toolCall('n-1', 'add_request_note', { note: 'Gate code 4471' }, 'tc-note-1'));
  assert.equal(first.note_added, true); assert.equal(first.office_alert, 'sent'); assert.equal(first.duplicate, undefined);
  assert.equal(retry.duplicate, true); assert.equal(retry.office_alert, 'sent'); assert.equal(retry.request_id, first.request_id);
  assert.deepEqual(saved('n-1').notes, ['Gate code 4471']);
  assert.equal(sms().length - smsBefore, 1); assert.equal(emails().length - emailsBefore, 1);
  // The office alert's Resend key comes from the tool call, not from the note count.
  assert.match(emails().at(-1).key, new RegExp(`^${first.request_id}-alert-note-[0-9a-f]{32}$`));
});

test('the same note text under a new toolCall id is not appended or alerted again', async t => {
  const { post, saved, sms } = await fixture(t);
  await post(toolCall('n-2', 'submit_service_request', intake));
  const before = sms().length;
  await post(toolCall('n-2', 'add_request_note', { note: 'Dog in the yard' }, 'tc-a'));
  const again = await post(toolCall('n-2', 'add_request_note', { note: '  Dog in the yard ' }, 'tc-b'));
  assert.equal(again.duplicate, true); assert.equal(again.note_added, true);
  assert.deepEqual(saved('n-2').notes, ['Dog in the yard']); assert.equal(sms().length - before, 1);
});

test('a different note is appended and alerted with its own Resend key', async t => {
  const { post, saved, sms, emails } = await fixture(t);
  await post(toolCall('n-3', 'submit_service_request', intake));
  const before = sms().length;
  const a = await post(toolCall('n-3', 'add_request_note', { note: 'Gate code 4471' }, 'tc-1'));
  const b = await post(toolCall('n-3', 'add_request_note', { note: 'Prefers a text first' }, 'tc-2'));
  assert.equal(a.office_alert, 'sent'); assert.equal(b.office_alert, 'sent'); assert.equal(b.duplicate, undefined);
  assert.deepEqual(saved('n-3').notes, ['Gate code 4471', 'Prefers a text first']);
  assert.equal(sms().length - before, 2);
  const keys = emails().slice(-2).map(e => e.key);
  assert.notEqual(keys[0], keys[1]);
});

test('concurrent duplicate add_request_note calls save one note and send one alert', async t => {
  const { post, saved, sms, emails } = await fixture(t, 150);
  await post(toolCall('n-4', 'submit_service_request', intake));
  const [smsBefore, emailsBefore] = [sms().length, emails().length];
  const body = toolCall('n-4', 'add_request_note', { note: 'Water shut off at the street' }, 'tc-race');
  const results = await Promise.all([post(body), post(body), post(body)]);
  for (const r of results) { assert.equal(r.note_added, true); assert.equal(r.office_alert, 'sent'); }
  assert.deepEqual(saved('n-4').notes, ['Water shut off at the street']);
  assert.equal(sms().length - smsBefore, 1); assert.equal(emails().length - emailsBefore, 1);
});

test('a failed note is not remembered, so the corrected retry still saves', async t => {
  const { post, saved } = await fixture(t);
  assert.equal((await post(toolCall('n-5', 'add_request_note', { note: 'Back gate' }, 'tc-early'))).saved, false);
  await post(toolCall('n-5', 'submit_service_request', intake));
  assert.equal((await post(toolCall('n-5', 'add_request_note', { note: 'Back gate' }, 'tc-early'))).note_added, true);
  assert.deepEqual(saved('n-5').notes, ['Back gate']);
});

test('note alerts past the 20-note cap still get distinct Resend keys', async t => {
  const { post, emails } = await fixture(t);
  await post(toolCall('n-6', 'submit_service_request', intake));
  for (let i = 0; i < 22; i++) await post(toolCall('n-6', 'add_request_note', { note: `Note ${i}` }, `tc-${i}`));
  const keys = emails().filter(e => /-alert-note-/.test(e.key)).map(e => e.key);
  assert.equal(keys.length, 22); assert.equal(new Set(keys).size, 22);
});

test('a retried add_customer_email sends one confirmation; a corrected address is saved and sent', async t => {
  const { post, saved, emails } = await fixture(t);
  await post(toolCall('e-1', 'submit_service_request', intake));
  const add = email => toolCall('e-1', 'add_customer_email', { email, confirmed_after_spelling_back: true }, `tc-${email}`);
  const toCaller = () => emails().filter(e => e.body.to[0].endsWith('@example.org'));
  const first = await post(add('linda@example.org'));
  const retry = await post(add('linda@example.org'));
  assert.equal(first.caller_email, 'accepted'); assert.equal(retry.duplicate, true); assert.equal(toCaller().length, 1);
  const fixed = await post(add('lynda@example.org'));
  assert.equal(fixed.caller_email, 'accepted'); assert.equal(saved('e-1').email, 'lynda@example.org');
  assert.equal(toCaller().length, 2); assert.notEqual(toCaller()[0].key, toCaller()[1].key);
  // Back to the first address: saved again (not a stale duplicate).
  const back = await post(add('linda@example.org'));
  assert.equal(back.email_added, true); assert.equal(back.duplicate, undefined); assert.equal(saved('e-1').email, 'linda@example.org');
});

test('an email already saved by submit keeps the submit Resend key', async t => {
  const { post, emails } = await fixture(t);
  const saved = await post(toolCall('e-2', 'submit_service_request', { ...intake, email: 'linda@example.org', email_confirmed: true }));
  await post(toolCall('e-2', 'add_customer_email', { email: 'linda@example.org', confirmed_after_spelling_back: true }, 'tc-late'));
  const keys = emails().filter(e => e.body.to[0] === 'linda@example.org').map(e => e.key);
  assert.deepEqual(keys, [`${saved.request_id}-caller`, `${saved.request_id}-caller`]);
});

test('every tool call logs one line with ids, outcome and time, never the arguments', async t => {
  const { post } = await fixture(t);
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(String(line)));
  await post(toolCall('l-1', 'submit_service_request', intake, 'tc-s'));
  await post(toolCall('l-1', 'add_request_note', { note: 'Gate code 4471' }, 'tc-n'));
  await post(toolCall('l-1', 'add_request_note', { note: 'Gate code 4471' }, 'tc-n'));
  await post(toolCall('l-1', 'no_such_tool', {}, 'tc bad\nid'));
  const tools = lines.filter(l => l.startsWith('tool-call '));
  assert.equal(tools.length, 4);
  assert.match(tools[0], /^tool-call name=submit_service_request call=l-1 tool_call=tc-s outcome=ok ms=\d+$/);
  assert.match(tools[1], /^tool-call name=add_request_note call=l-1 tool_call=tc-n outcome=ok ms=\d+$/);
  assert.match(tools[2], /outcome=duplicate ms=\d+$/);
  assert.match(tools[3], /^tool-call name=no_such_tool call=l-1 tool_call=tc_bad_id outcome=refused ms=\d+$/);
  for (const l of lines) { assert.doesNotMatch(l, /4471|Linda|Birch|6155550142/); }
});
