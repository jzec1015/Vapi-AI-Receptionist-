import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './server.mjs';

// Vapi retries a tool call (server.backoffPlan) with the same body: same toolCall id, same arguments. A retry must never
// double-send, must re-send what failed, and must finish sends cut off by a restart.
const key = 'synthetic-test-key-not-used-in-production';
const routes = JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'] } });
const alertEnv = { ALERT_ROUTES: routes, TELNYX_API_KEY: 'fixture-only', TELNYX_FROM: '+15550000000', RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com' };
const intake = { name: 'Linda Harper', address: '48 Birch Road', issue: 'Slow drain in the kitchen', is_test: false, callback_phone: '6155550142', email_status: 'declined' };
const toolCall = (id, name, args, toolId = 'tool-1') => ({ message: { type: 'tool-calls', call: { id, assistantId: 'client-a', customer: { number: '+16155550100' } },
  toolCallList: [{ id: toolId, function: { name, arguments: args } }] } });
const note = (callId, text, toolId) => toolCall(callId, 'add_request_note', { note: text }, toolId);
const email = (callId, address, toolId) => toolCall(callId, 'add_customer_email', { email: address, confirmed_after_spelling_back: true }, toolId);
const tempDir = t => { const dir = mkdtempSync(join(tmpdir(), 'idem-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
// behave(url, body) -> status code, or a Promise for one (a Promise that never settles is a send cut off by a restart).
async function fixture(t, { behave = () => 200, dir = tempDir(t) } = {}) {
  const sent = [];
  const send = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, key: init.headers?.['Idempotency-Key'], body });
    return new Response('{}', { status: await behave(url, body) });
  };
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ...alertEnv }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const stop = () => { if (!app.listening) return; app.closeAllConnections(); return new Promise(resolve => app.close(resolve)); };
  t.after(stop);
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = async body => JSON.parse((await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key },
    body: JSON.stringify(body) })).json()).results[0].result);
  const saved = callId => { const db = new DatabaseSync(join(dir, 'requests.sqlite')); try { return JSON.parse(db.prepare('SELECT details FROM requests WHERE call_id = ?').get(callId).details); } finally { db.close(); } };
  const sms = () => sent.filter(s => s.url.includes('telnyx'));
  const emails = () => sent.filter(s => s.url.includes('resend'));
  return { app, dir, post, sent, saved, sms, emails, stop };
}
const settleLater = ms => new Promise(resolve => setTimeout(resolve, ms));
const never = () => new Promise(() => {});
// A process that dies mid-send: app 1's outbound calls hang, then its connections are cut and it closes.
async function crashMidSend(t, dir, steps) {
  let hang = false;
  const first = await fixture(t, { dir, behave: () => hang ? never() : 200 });
  await steps.before?.(first);
  hang = true;
  first.post(steps.cut).catch(() => {});
  await settleLater(150);
  await first.stop();
  return first;
}

test('a retried add_request_note (same toolCall id) appends once and alerts once', async t => {
  const { post, saved, sms, emails } = await fixture(t);
  await post(toolCall('n-1', 'submit_service_request', intake, 'tc-submit'));
  const [smsBefore, emailsBefore] = [sms().length, emails().length];
  const first = await post(note('n-1', 'Gate code 4471', 'tc-note-1'));
  const retry = await post(note('n-1', 'Gate code 4471', 'tc-note-1'));
  assert.equal(first.note_added, true); assert.equal(first.office_alert, 'sent'); assert.equal(first.duplicate, undefined);
  assert.equal(retry.duplicate, true); assert.equal(retry.office_alert, 'sent'); assert.equal(retry.request_id, first.request_id);
  assert.deepEqual(saved('n-1').notes, ['Gate code 4471']);
  assert.equal(sms().length - smsBefore, 1); assert.equal(emails().length - emailsBefore, 1);
  // The office alert's Resend key comes from the tool call, not from the note count.
  assert.match(emails().at(-1).key, new RegExp(`^${first.request_id}-alert-note-[0-9a-f]{32}$`));
});

test('a note correction A, B, then A again (new tool calls) is saved and alerted every time', async t => {
  const { post, saved, sms } = await fixture(t);
  await post(toolCall('n-2', 'submit_service_request', intake));
  const before = sms().length;
  for (const [text, id] of [['Callback number: 615 555 0100', 'tc-a'], ['Callback number: 615 555 0199', 'tc-b'], ['Callback number: 615 555 0100', 'tc-c']]) {
    const r = await post(note('n-2', text, id));
    assert.equal(r.note_added, true); assert.equal(r.duplicate, undefined); assert.equal(r.office_alert, 'sent');
  }
  assert.deepEqual(saved('n-2').notes, ['Callback number: 615 555 0100', 'Callback number: 615 555 0199', 'Callback number: 615 555 0100']);
  assert.equal(sms().length - before, 3);
  assert.match(sms().at(-1).body.text, /Note: Callback number: 615 555 0100/);
});

test('a different note is appended and alerted with its own Resend key', async t => {
  const { post, saved, sms, emails } = await fixture(t);
  await post(toolCall('n-3', 'submit_service_request', intake));
  const before = sms().length;
  const a = await post(note('n-3', 'Gate code 4471', 'tc-1'));
  const b = await post(note('n-3', 'Prefers a text first', 'tc-2'));
  assert.equal(a.office_alert, 'sent'); assert.equal(b.office_alert, 'sent'); assert.equal(b.duplicate, undefined);
  assert.deepEqual(saved('n-3').notes, ['Gate code 4471', 'Prefers a text first']);
  assert.equal(sms().length - before, 2);
  const keys = emails().slice(-2).map(e => e.key);
  assert.notEqual(keys[0], keys[1]);
});

test('concurrent duplicate add_request_note calls save one note and send one alert', async t => {
  const { post, saved, sms, emails } = await fixture(t, { behave: async () => { await settleLater(150); return 200; } });
  await post(toolCall('n-4', 'submit_service_request', intake));
  const [smsBefore, emailsBefore] = [sms().length, emails().length];
  const body = note('n-4', 'Water shut off at the street', 'tc-race');
  const results = await Promise.all([post(body), post(body), post(body)]);
  for (const r of results) { assert.equal(r.note_added, true); assert.equal(r.office_alert, 'sent'); }
  assert.deepEqual(saved('n-4').notes, ['Water shut off at the street']);
  assert.equal(sms().length - smsBefore, 1); assert.equal(emails().length - emailsBefore, 1);
});

test('a refused note is not remembered, so the same tool call works once the request is saved', async t => {
  const { post, saved } = await fixture(t);
  assert.equal((await post(note('n-5', 'Back gate', 'tc-early'))).saved, false);
  await post(toolCall('n-5', 'submit_service_request', intake));
  assert.equal((await post(note('n-5', 'Back gate', 'tc-early'))).note_added, true);
  assert.deepEqual(saved('n-5').notes, ['Back gate']);
});

test('note alerts past the 20-note cap still get distinct Resend keys', async t => {
  const { post, emails } = await fixture(t);
  await post(toolCall('n-6', 'submit_service_request', intake));
  for (let i = 0; i < 22; i++) await post(note('n-6', `Note ${i}`, `tc-${i}`));
  const keys = emails().filter(e => /-alert-note-/.test(e.key)).map(e => e.key);
  assert.equal(keys.length, 22); assert.equal(new Set(keys).size, 22);
});

test('a retry after a failed note alert re-sends only the channel that failed', async t => {
  let smsStatus = 500;
  const { post, sms, emails } = await fixture(t, { behave: url => url.includes('telnyx') ? smsStatus : 200 });
  smsStatus = 200; await post(toolCall('f-1', 'submit_service_request', intake)); smsStatus = 500;
  const [smsBefore, emailsBefore] = [sms().length, emails().length];
  const first = await post(note('f-1', 'Gate code 1', 'tc-n'));
  assert.equal(first.office_alert, 'needs_review');
  smsStatus = 200;
  const retry = await post(note('f-1', 'Gate code 1', 'tc-n'));
  assert.equal(retry.duplicate, true); assert.equal(retry.office_alert, 'sent');
  assert.equal(sms().length - smsBefore, 2, 'the failed SMS is sent again'); assert.equal(emails().length - emailsBefore, 1, 'the email that went out is not');
  await post(note('f-1', 'Gate code 1', 'tc-n'));
  assert.equal(sms().length - smsBefore, 2); assert.equal(emails().length - emailsBefore, 1);
});

test('a retry after a failed alert email re-sends it with the same Resend key, and not the SMS', async t => {
  let mailStatus = 200;
  const { post, sms, emails } = await fixture(t, { behave: url => url.includes('resend') ? mailStatus : 200 });
  await post(toolCall('f-2', 'submit_service_request', intake)); mailStatus = 500;
  const [smsBefore, emailsBefore] = [sms().length, emails().length];
  assert.equal((await post(note('f-2', 'Gate code 2', 'tc-n'))).office_alert, 'needs_review');
  mailStatus = 200;
  assert.equal((await post(note('f-2', 'Gate code 2', 'tc-n'))).office_alert, 'sent');
  assert.equal(sms().length - smsBefore, 1); assert.equal(emails().length - emailsBefore, 2);
  assert.equal(emails().at(-1).key, emails().at(-2).key);
});

test('a retried submit_service_request after a failed SMS re-sends only the SMS', async t => {
  let smsStatus = 500;
  const { post, sms, emails } = await fixture(t, { behave: url => url.includes('telnyx') ? smsStatus : 200 });
  const first = await post(toolCall('f-3', 'submit_service_request', { ...intake, email: 'linda@example.org', email_confirmed: true }));
  assert.equal(first.office_alert, 'needs_review'); assert.equal(first.caller_email, 'accepted');
  smsStatus = 200;
  const retry = await post(toolCall('f-3', 'submit_service_request', { ...intake, email: 'linda@example.org', email_confirmed: true }));
  assert.equal(retry.duplicate, true); assert.equal(retry.office_alert, 'sent'); assert.equal(retry.request_id, first.request_id);
  assert.equal(sms().length, 2); assert.equal(emails().length, 2, 'office alert email + caller confirmation, each once');
});

test('a retry after a failed caller confirmation re-sends it', async t => {
  let fail = false;
  const { post, emails } = await fixture(t, { behave: (url, body) => fail && body.to?.[0]?.endsWith('@example.org') ? 500 : 200 });
  await post(toolCall('f-4', 'submit_service_request', intake)); fail = true;
  assert.equal((await post(email('f-4', 'linda@example.org', 'tc-e'))).caller_email, 'needs_review');
  fail = false;
  const retry = await post(email('f-4', 'linda@example.org', 'tc-e'));
  assert.equal(retry.duplicate, true); assert.equal(retry.caller_email, 'accepted');
  assert.equal(emails().filter(e => e.body.to[0] === 'linda@example.org').length, 2);
});

test('restart before the note alert went out: the retry on the new process sends it once', async t => {
  const dir = tempDir(t);
  await crashMidSend(t, dir, { before: f => f.post(toolCall('r-1', 'submit_service_request', intake)), cut: note('r-1', 'Gate code 9', 'tc-n') });
  const second = await fixture(t, { dir });
  const retry = await second.post(note('r-1', 'Gate code 9', 'tc-n'));
  assert.equal(retry.office_alert, 'sent'); assert.equal(retry.duplicate, true);
  assert.equal(second.sms().length, 1); assert.equal(second.emails().length, 1);
  assert.deepEqual(second.saved('r-1').notes, ['Gate code 9']);
  await second.post(note('r-1', 'Gate code 9', 'tc-n'));
  assert.equal(second.sent.length, 2);
});

test('restart before submit_service_request sent anything: the retry sends the alert and receipts', async t => {
  const dir = tempDir(t);
  await crashMidSend(t, dir, { cut: toolCall('r-2', 'submit_service_request', { ...intake, email: 'linda@example.org', email_confirmed: true }) });
  const second = await fixture(t, { dir });
  const retry = await second.post(toolCall('r-2', 'submit_service_request', { ...intake, email: 'linda@example.org', email_confirmed: true }));
  assert.equal(retry.office_alert, 'sent'); assert.equal(retry.caller_email, 'accepted');
  assert.equal(second.sms().length, 1); assert.equal(second.emails().length, 2);
});

test('restart before sends finished, and Vapi never retries: the outbox sweep finishes submit, note and email', async t => {
  const dir = tempDir(t);
  await crashMidSend(t, dir, { cut: toolCall('r-3', 'submit_service_request', intake) });
  await crashMidSend(t, dir, { cut: note('r-3', 'Dog in the yard', 'tc-n') });
  await crashMidSend(t, dir, { cut: email('r-3', 'linda@example.org', 'tc-e') });
  const second = await fixture(t, { dir });
  assert.deepEqual(await second.app.sweepOutbox(Date.now()), [], 'nothing is due before 30 s');
  const done = await second.app.sweepOutbox(Date.now() + 31000);
  assert.equal(done.length, 3);
  assert.equal(second.sms().length, 2, 'new-job SMS + note SMS');
  assert.equal(second.emails().filter(e => e.body.to[0] === 'office@example.com').length, 2);
  assert.equal(second.emails().filter(e => e.body.to[0] === 'linda@example.org').length, 1);
  assert.deepEqual(await second.app.sweepOutbox(Date.now() + 120000), []);
  // A late Vapi retry now gets the finished result and sends nothing more.
  const late = await second.post(note('r-3', 'Dog in the yard', 'tc-n'));
  assert.equal(late.office_alert, 'sent'); assert.equal(second.sent.length, 5);
});

test('a retried add_customer_email sends one confirmation; a corrected address is saved and sent', async t => {
  const { post, saved, emails } = await fixture(t);
  await post(toolCall('e-1', 'submit_service_request', intake));
  const toCaller = () => emails().filter(e => e.body.to[0].endsWith('@example.org'));
  const first = await post(email('e-1', 'linda@example.org', 'tc-1'));
  const retry = await post(email('e-1', 'linda@example.org', 'tc-1'));
  assert.equal(first.caller_email, 'accepted'); assert.equal(retry.duplicate, true); assert.equal(toCaller().length, 1);
  const fixed = await post(email('e-1', 'lynda@example.org', 'tc-2'));
  assert.equal(fixed.caller_email, 'accepted'); assert.equal(saved('e-1').email, 'lynda@example.org');
  assert.equal(toCaller().length, 2); assert.notEqual(toCaller()[0].key, toCaller()[1].key);
  // Back to the first address: saved again; that address already has its confirmation, so it is not sent twice.
  const back = await post(email('e-1', 'linda@example.org', 'tc-3'));
  assert.equal(back.email_added, true); assert.equal(back.duplicate, undefined); assert.equal(back.caller_email, 'accepted');
  assert.equal(saved('e-1').email, 'linda@example.org'); assert.equal(toCaller().length, 2);
});

test('email A, B, then A again while the first send is still running ends with A saved', async t => {
  const { post, saved } = await fixture(t, { behave: async (url, body) => { if (body.to?.[0] === 'a@example.org') await settleLater(400); return 200; } });
  await post(toolCall('e-3', 'submit_service_request', intake));
  const first = post(email('e-3', 'a@example.org', 'tc-1'));
  await settleLater(80);
  await post(email('e-3', 'b@example.org', 'tc-2'));
  const again = await post(email('e-3', 'a@example.org', 'tc-3'));
  await first;
  assert.equal(again.email_added, true); assert.equal(again.duplicate, undefined);
  assert.equal(saved('e-3').email, 'a@example.org');
});

test('concurrent identical add_customer_email calls send one confirmation', async t => {
  const { post, emails } = await fixture(t, { behave: async () => { await settleLater(150); return 200; } });
  await post(toolCall('e-4', 'submit_service_request', intake));
  const body = email('e-4', 'linda@example.org', 'tc-race');
  const results = await Promise.all([post(body), post(body), post(body)]);
  for (const r of results) assert.equal(r.caller_email, 'accepted');
  assert.equal(emails().filter(e => e.body.to[0] === 'linda@example.org').length, 1);
});

test('an email already confirmed by submit is not sent a second time', async t => {
  const { post, emails } = await fixture(t);
  const saved = await post(toolCall('e-2', 'submit_service_request', { ...intake, email: 'linda@example.org', email_confirmed: true }));
  const late = await post(email('e-2', 'linda@example.org', 'tc-late'));
  assert.equal(late.caller_email, 'accepted');
  const keys = emails().filter(e => e.body.to[0] === 'linda@example.org').map(e => e.key);
  assert.deepEqual(keys, [`${saved.request_id}-caller`]);
});

test('every tool call logs one line with ids, outcome and time, never the arguments', async t => {
  const { post } = await fixture(t);
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(String(line)));
  await post(toolCall('l-1', 'submit_service_request', intake, 'tc-s'));
  await post(note('l-1', 'Gate code 4471', 'tc-n'));
  await post(note('l-1', 'Gate code 4471', 'tc-n'));
  await post(toolCall('l-1', 'no_such_tool', {}, 'tc bad\nid'));
  const tools = lines.filter(l => l.startsWith('tool-call '));
  assert.equal(tools.length, 4);
  assert.match(tools[0], /^tool-call name=submit_service_request call=l-1 tool_call=tc-s outcome=ok ms=\d+$/);
  assert.match(tools[1], /^tool-call name=add_request_note call=l-1 tool_call=tc-n outcome=ok ms=\d+$/);
  assert.match(tools[2], /outcome=duplicate ms=\d+$/);
  assert.match(tools[3], /^tool-call name=no_such_tool call=l-1 tool_call=tc_bad_id outcome=refused ms=\d+$/);
  for (const l of lines) { assert.doesNotMatch(l, /4471|Linda|Birch|6155550142/); }
});
