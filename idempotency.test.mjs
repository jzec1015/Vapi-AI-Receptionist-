import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp, alertText } from './server.mjs';

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
async function fixture(t, { behave = () => 200, dir = tempDir(t), extra = {} } = {}) {
  const sent = [];
  const send = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, key: init.headers?.['Idempotency-Key'], body });
    return new Response('{}', { status: await behave(url, body) });
  };
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ...alertEnv, ...extra }, send);
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
  const first = await fixture(t, { dir, extra: steps.extra, behave: () => hang ? never() : 200 });
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

const twoNumbers = { ALERT_ROUTES: JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', sms: ['+15550000001', '+15550000002'], email: ['office@example.com'] } }) };
const emailOnly = { ALERT_ROUTES: JSON.stringify({ 'client-a': { business: 'Trial Co', sms: [], email: ['office@example.com'] } }) };
const outboxRows = dir => { const db = new DatabaseSync(join(dir, 'requests.sqlite')); try { return db.prepare('SELECT count(*) AS n FROM outbox').get().n; } finally { db.close(); } };

test('a duplicate submit after a note re-sends only the SMS that failed, never the delivered ones', async t => {
  const { post, sms, emails } = await fixture(t, { extra: twoNumbers, behave: (url, body) => url.includes('telnyx') && body.to === '+15550000002' ? 400 : 200 });
  const first = await post(toolCall('k-1', 'submit_service_request', intake, 's1'));
  assert.equal(first.office_alert, 'needs_review');
  await post(note('k-1', 'Gate 1', 'n1'));
  const [smsBefore, emailsBefore] = [sms().length, emails().length];
  await post(toolCall('k-1', 'submit_service_request', intake, 's2'));
  assert.deepEqual(sms().slice(smsBefore).map(s => s.body.to), ['+15550000002']);
  assert.equal(emails().length, emailsBefore, 'the delivered alert email is not sent again');
});

test('restart mid-submit, a note added, then the sweep: the new-job alert keeps its v1.5 Resend key', async t => {
  const dir = tempDir(t);
  const first = await crashMidSend(t, dir, { cut: toolCall('k-2', 'submit_service_request', intake) });
  const firstKey = first.emails().find(e => e.body.to[0] === 'office@example.com').key;
  const second = await fixture(t, { dir });
  await second.post(note('k-2', 'Gate 5', 'n1'));
  await second.app.sweepOutbox(Date.now() + 31000);
  const office = second.emails().filter(e => e.body.to[0] === 'office@example.com').map(e => e.key);
  assert.equal(office.length, 2, 'note alert + the finished new-job alert');
  assert.ok(office.includes(firstKey)); assert.match(firstKey, /-alert-new-0$/);
  assert.equal(second.sms().length, 2);
});

// v1.8.1 bundle: office_retries alone owns "the new-job alert reached nobody" (retry every minute, 5 times, then one
// Anchorline notice). The outbox no longer keeps the row or sends its own give-up email for that alert.
const MIN = 60000;
const requestId = (dir, callId) => { const db = new DatabaseSync(join(dir, 'requests.sqlite')); try { return db.prepare('SELECT id FROM requests WHERE call_id = ?').get(callId).id; } finally { db.close(); } };
const retryRow = (dir, callId) => { const db = new DatabaseSync(join(dir, 'requests.sqlite')); try { return db.prepare('SELECT * FROM office_retries WHERE call_id = ?').get(callId); } finally { db.close(); } };

test('an office alert that reached no channel is retried by office_retries, not the outbox, and delivered once', async t => {
  let fail = true;
  const { app, post, dir, emails } = await fixture(t, { extra: emailOnly, behave: () => fail ? 500 : 200 });
  const saved = await post(toolCall('k-3', 'submit_service_request', intake));
  assert.equal(saved.saved, true); assert.equal(saved.office_alert, 'needs_review');
  assert.equal(outboxRows(dir), 0, 'the outbox is done once the sends ran; office_retries owns the retry');
  assert.equal(retryRow(dir, 'k-3').done, null);
  fail = false;
  const before = emails().length;
  const now = Date.now();
  assert.deepEqual(await app.sweepOutbox(now + 31000), []);
  assert.equal(emails().length, before, 'the outbox sends nothing');
  assert.deepEqual(await app.sweepOfficeRetries(now + MIN + 1000), ['sent']);
  assert.equal(emails().length - before, 1);
  assert.deepEqual(emails().slice(before).map(e => e.key), [`${saved.request_id}-alert-new-0`]);
  assert.equal((await post(toolCall('k-3', 'submit_service_request', intake))).office_alert, 'sent_after_retry');
  assert.equal(emails().length - before, 1, 'a Vapi retry afterwards sends nothing more');
});

test('when every retry fails, Anchorline gets one office_retries notice and no outbox give-up email', async t => {
  const errors = [];
  t.mock.method(console, 'error', line => errors.push(String(line)));
  t.mock.method(console, 'warn', () => {});
  const { app, post, dir, emails } = await fixture(t, { extra: { ...emailOnly, OFFICE_EMAIL: 'ops@anchorline.example' },
    behave: (url, body) => body.to?.[0] === 'office@example.com' ? 500 : 200 });
  const saved = await post(toolCall('k-4', 'submit_service_request', intake));
  // Both sweepers run side by side for an hour, as they do in production.
  const start = Date.now();
  for (let now = start + 31000; now < start + 60 * MIN; now += 30000) await Promise.all([app.sweepOutbox(now), app.sweepOfficeRetries(now)]);
  assert.equal(outboxRows(dir), 0);
  assert.equal(emails().filter(e => e.body.to[0] === 'office@example.com').length, 6, 'first try + 5 office retries, nothing from the outbox');
  assert.equal(emails().filter(e => /ALERT NOT DELIVERED/.test(e.body.subject)).length, 0, 'the old outbox give-up email is gone');
  const notice = emails().filter(e => e.body.to[0] === 'ops@anchorline.example' && /^Office alert failed/.test(e.body.subject));
  assert.equal(notice.length, 1); assert.equal(notice[0].key, `${saved.request_id}-office-alert-failed`);
  assert.match(notice[0].body.text, new RegExp(`Request reference: ${saved.request_id}`));
  assert.equal(retryRow(dir, 'k-4').done, 'gave_up_notice_accepted');
  assert.ok(errors.some(l => /^office-alert GAVE UP call=k-4 /.test(l)));
  assert.ok(!errors.some(l => /OUTBOX GAVE UP|outbox GAVE UP/.test(l)));
});

test('restart finish and office_retries on the same alert: each SMS number and the email are sent once', async t => {
  const dir = tempDir(t);
  // The first process saves the job, then dies with every alert send cut off (no channel recorded as sent).
  await crashMidSend(t, dir, { extra: twoNumbers, cut: toolCall('u-1', 'submit_service_request', intake) });
  const second = await fixture(t, { dir, extra: twoNumbers, behave: async () => { await settleLater(120); return 200; } });
  const now = Date.now();
  // The outbox restart-finish (due at 30 s) and the office retry (due at 60 s) run at the same moment, then again later.
  await Promise.all([second.app.sweepOutbox(now + MIN + 1000), second.app.sweepOfficeRetries(now + MIN + 1000), second.post(toolCall('u-1', 'submit_service_request', intake))]);
  await Promise.all([second.app.sweepOutbox(now + 3 * MIN), second.app.sweepOfficeRetries(now + 3 * MIN)]);
  for (let i = 4; i < 10; i++) await second.app.sweepOfficeRetries(now + i * MIN);
  const perNumber = to => second.sms().filter(s => s.body.to === to).length;
  assert.equal(perNumber('+15550000001'), 1); assert.equal(perNumber('+15550000002'), 1);
  const id = requestId(dir, 'u-1');
  assert.deepEqual(second.emails().filter(e => e.body.to[0] === 'office@example.com').map(e => e.key), [`${id}-alert-new-0`]);
  assert.equal(outboxRows(dir), 0);
  assert.equal(retryRow(dir, 'u-1').done, 'sent', 'the office retry is closed by the delivery, not retried');
});

test('a note row left stale by a crash loop, whose alert reached nobody, sends Anchorline exactly one notice', async t => {
  t.mock.method(console, 'error', () => {}); t.mock.method(console, 'warn', () => {});
  let failNotes = false, failNotice = true;
  const { app, post, dir, sms, emails } = await fixture(t, { extra: { OFFICE_EMAIL: 'ops@anchorline.example' }, behave: (url, body) => {
    if (failNotes && (url.includes('telnyx') || body.to?.[0] === 'office@example.com')) return 500;
    if (/^Office alert failed/.test(body.subject || '') && failNotice) { failNotice = false; return 500; }
    return 200;
  } });
  const saved = await post(toolCall('s-1', 'submit_service_request', intake));
  failNotes = true;
  assert.equal((await post(note('s-1', 'Gate code 7', 'tc-n'))).office_alert, 'needs_review');
  assert.equal(outboxRows(dir), 1);
  failNotes = false;
  const [smsBefore, alertsBefore] = [sms().length, emails().filter(e => e.body.to[0] === 'office@example.com').length];
  const later = Date.now() + 2 * 3600000;
  for (let i = 0; i < 5; i++) await app.sweepOutbox(later + i * MIN);
  assert.equal(sms().length, smsBefore, 'never sent late');
  assert.equal(emails().filter(e => e.body.to[0] === 'office@example.com').length, alertsBefore);
  const notices = emails().filter(e => e.body.to[0] === 'ops@anchorline.example' && /^Office alert failed/.test(e.body.subject));
  assert.equal(notices.length, 2, 'the first notice failed and was tried again once');
  assert.equal(new Set(notices.map(n => n.key)).size, 1, 'one stable Idempotency-Key, so at most one lands');
  assert.match(notices[0].key, new RegExp(`^${saved.request_id}-office-alert-failed-note-[0-9a-f]{16}$`));
  assert.match(notices[0].body.text, /over an hour[\s\S]*Note: Gate code 7[\s\S]*Request reference: /);
  assert.equal(outboxRows(dir), 0);
});

test('a stale undelivered submit row is dropped by the outbox and still ends in the office_retries notice', async t => {
  t.mock.method(console, 'error', () => {}); t.mock.method(console, 'warn', () => {});
  const dir = tempDir(t);
  const extra = { OFFICE_EMAIL: 'ops@anchorline.example' };
  await crashMidSend(t, dir, { extra, cut: toolCall('s-2', 'submit_service_request', intake) });
  const second = await fixture(t, { dir, extra, behave: (url, body) => url.includes('telnyx') || body.to?.[0] === 'office@example.com' ? 500 : 200 });
  const later = Date.now() + 2 * 3600000;
  assert.deepEqual(await second.app.sweepOutbox(later), []);
  assert.equal(outboxRows(dir), 0); assert.equal(second.sent.length, 0, 'the outbox sends nothing late');
  for (let i = 0; i < 8; i++) await Promise.all([second.app.sweepOutbox(later + i * 61000), second.app.sweepOfficeRetries(later + i * 61000)]);
  const id = requestId(dir, 's-2');
  const notices = second.emails().filter(e => e.body.to[0] === 'ops@anchorline.example' && /^Office alert failed/.test(e.body.subject));
  assert.equal(notices.length, 1); assert.equal(notices[0].key, `${id}-office-alert-failed`);
  assert.equal(retryRow(dir, 's-2').done, 'gave_up_notice_accepted');
});

test('an outbox and tool_calls table from an earlier build (no created_at) never breaks submit or notes', async t => {
  t.mock.method(console, 'warn', () => {});
  const dir = tempDir(t);
  const old = new DatabaseSync(join(dir, 'requests.sqlite'));
  old.exec(`CREATE TABLE outbox (ref TEXT PRIMARY KEY, kind TEXT NOT NULL, call_id TEXT NOT NULL, tool_call_id TEXT, args_key TEXT, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE tool_calls (call_id TEXT NOT NULL, name TEXT NOT NULL, args_key TEXT NOT NULL, tool_call_id TEXT NOT NULL, created_at TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY (call_id, name, args_key));
    INSERT INTO outbox (ref, kind, call_id, due_at, attempts) VALUES ('submit\nold-call', 'submit', 'old-call', ${Date.now() - 120000}, 1);`);
  old.close();
  const { app, post, sms } = await fixture(t, { dir });
  const saved = await post(toolCall('o-1', 'submit_service_request', intake));
  assert.equal(saved.saved, true); assert.equal(saved.office_alert, 'sent');
  assert.equal((await post(note('o-1', 'Side door', 'tc-n'))).office_alert, 'sent');
  assert.equal(sms().length, 2);
  const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  try {
    const columns = db.prepare('PRAGMA table_info(outbox)').all().map(c => c.name);
    assert.ok(columns.includes('created_at') && columns.includes('gave_up'));
    assert.ok(db.prepare("SELECT created_at FROM outbox WHERE ref = 'submit\nold-call'").get().created_at > 0, 'old rows get a created_at');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tool_calls_v0'").get());
  } finally { db.close(); }
  await app.sweepOutbox(Date.now() + 31000); // the old row (no request behind it) never throws the sweep
});

test('a stale submit row: the outbox sends nothing late, unsent receipts end as dropped_stale, office_retries sends the alert once marked delayed', async t => {
  const lines = [];
  t.mock.method(console, 'log', l => lines.push(String(l))); t.mock.method(console, 'warn', l => lines.push(String(l)));
  const dir = tempDir(t);
  const extra = { OFFICE_EMAIL: 'ops@anchorline.example' };
  await crashMidSend(t, dir, { extra, cut: toolCall('k-5', 'submit_service_request', { ...intake, email: 'linda@example.org', email_confirmed: true }) });
  const second = await fixture(t, { dir, extra });
  const later = Date.now() + 2 * 3600000;
  assert.deepEqual(await second.app.sweepOutbox(later), []);
  assert.equal(second.sent.length, 0, 'the outbox sends nothing late'); assert.equal(outboxRows(dir), 0);
  const stored = () => { const db = new DatabaseSync(join(dir, 'requests.sqlite')); try { return JSON.parse(db.prepare('SELECT result FROM requests').get().result); } finally { db.close(); } };
  assert.equal(stored().caller_email, 'dropped_stale'); assert.equal(stored().anchorline_email, 'dropped_stale');
  assert.ok(lines.some(l => /^outbox stale-dropped kind=submit call=k-5 .*receipts=dropped_stale/.test(l)));
  // The job still reaches the shop, once, marked as delayed (main's behaviour, made visible).
  assert.deepEqual(await second.app.sweepOfficeRetries(later), ['sent']);
  for (let i = 1; i < 8; i++) await Promise.all([second.app.sweepOutbox(later + i * MIN), second.app.sweepOfficeRetries(later + i * MIN)]);
  assert.equal(second.sms().length, 1); assert.match(second.sms()[0].body.text, /^Anchorline AI: \(delayed \d+ min\) New call/);
  const id = requestId(dir, 'k-5');
  assert.deepEqual(second.emails().filter(e => e.body.to[0] === 'office@example.com').map(e => e.key), [`${id}-alert-new-0`]);
  assert.equal(second.emails().filter(e => e.body.to[0] !== 'office@example.com').length, 0, 'no late receipts');
  assert.ok(lines.some(l => /^office-alert delayed call=k-5 request=\S+ age_min=\d+$/.test(l)));
  assert.equal(stored().office_alert, 'sent_after_retry');
});

test('a long delayed SMS keeps the 302-character limit and the STOP footer; other alerts are unchanged', () => {
  const long = { name: 'Linda Harper', address: '48 Birch Road', issue: 'Slow drain '.repeat(60), callback_phone: '6155550142', notes: [] };
  const routeA = { business: 'Maple Plumbing' };
  const delayed = alertText(routeA, long, 'new', 'sms', { delayedMin: 125 });
  assert.ok(delayed.length <= 302, `${delayed.length} characters`);
  assert.match(delayed, /^Anchorline AI: \(delayed 125 min\) New call - Maple Plumbing/); assert.match(delayed, /\nReply STOP to opt out$/);
  assert.equal(alertText(routeA, long, 'new', 'sms', {}), alertText(routeA, long, 'new', 'sms'));
  assert.equal(alertText(routeA, long, 'new', 'email', { delayedMin: 0 }), alertText(routeA, long, 'new', 'email'));
});

// A process that dies after SMS #1 went out, with SMS #2 and the email cut off (still 'sending' in the ledger).
async function partialCrash(t, dir, cut) {
  const first = await fixture(t, { dir, extra: twoNumbers, behave: (url, body) => url.includes('telnyx') && body.to === '+15550000001' ? 200 : never() });
  const url = `http://127.0.0.1:${first.app.address().port}/vapi/webhook`;
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(cut) }).catch(() => {});
  await settleLater(150);
  await first.stop();
}
const ledger = (dir, ref) => { const db = new DatabaseSync(join(dir, 'requests.sqlite')); try { return Object.fromEntries(db.prepare('SELECT channel, status FROM deliveries WHERE ref = ?').all(ref).map(r => [r.channel, r.status])); } finally { db.close(); } };
const officeAlert = dir => { const db = new DatabaseSync(join(dir, 'requests.sqlite')); try { return JSON.parse(db.prepare('SELECT result FROM requests').get().result || '{}').office_alert; } catch { return undefined; } finally { db.close(); } };
const hangup = (id, summary = 'Caller Linda Harper at 48 Birch Road reported a leak.') => ({ message: { type: 'end-of-call-report', durationSeconds: 45, analysis: { summary },
  call: { id, assistantId: 'client-a', type: 'inboundPhoneCall', customer: { number: '+16155550100' } } } });
const perTo = (f, to) => f.sent.filter(s => s.body.to === to || s.body.to?.[0] === to).length;

test('office retry after a crash that came after a channel was sent: the cut channels are sent once, the sent one is not re-sent', async t => {
  const dir = tempDir(t);
  await partialCrash(t, dir, toolCall('a-1', 'submit_service_request', intake));
  const second = await fixture(t, { dir, extra: twoNumbers });
  assert.deepEqual(await second.app.sweepOfficeRetries(Date.now() + MIN + 1000), ['sent']);
  for (let i = 2; i < 8; i++) await second.app.sweepOfficeRetries(Date.now() + i * MIN);
  assert.equal(perTo(second, '+15550000001'), 0, 'SMS #1 already went out');
  assert.equal(perTo(second, '+15550000002'), 1); assert.equal(perTo(second, 'office@example.com'), 1);
  const id = requestId(dir, 'a-1');
  assert.deepEqual(ledger(dir, `${id}-alert-new-0`), { 'sms:+15550000001': 'sent', 'sms:+15550000002': 'sent', email: 'sent' });
  assert.equal(retryRow(dir, 'a-1').done, 'sent');
  // Known gap (accepted): the row is labelled sent_after_retry although SMS #1 went out on the first try.
  assert.equal(officeAlert(dir), 'sent_after_retry');
});

test('hang-up crash after SMS #1, SMS #2 and the email cut: the office retry sends each cut channel once, SMS #1 never', async t => {
  t.mock.method(console, 'warn', () => {});
  const dir = tempDir(t);
  await partialCrash(t, dir, hangup('h-1'));
  const id = requestId(dir, 'h-1');
  assert.deepEqual(ledger(dir, `${id}-alert-hangup-0`), { 'sms:+15550000001': 'sent', 'sms:+15550000002': 'sending', email: 'sending' });
  const second = await fixture(t, { dir, extra: twoNumbers });
  const now = Date.now();
  const outcomes = [];
  for (let i = 1; i < 10; i++) outcomes.push(...(await Promise.all([second.app.sweepOutbox(now + i * MIN + 1000), second.app.sweepOfficeRetries(now + i * MIN + 1000)]))[1]);
  assert.deepEqual(outcomes, ['sent'], 'one office retry pass, which delivered');
  assert.equal(perTo(second, '+15550000001'), 0);
  assert.equal(perTo(second, '+15550000002'), 1); assert.equal(perTo(second, 'office@example.com'), 1);
  assert.deepEqual(second.emails().map(e => e.key), [`${id}-alert-hangup-0`]);
  assert.deepEqual(ledger(dir, `${id}-alert-hangup-0`), { 'sms:+15550000001': 'sent', 'sms:+15550000002': 'sent', email: 'sent' });
  assert.equal(retryRow(dir, 'h-1').done, 'sent');
});

test('stale submit (restart 2 h later) cut after SMS #1: office_alert is not sent until office_retries delivers SMS #2 and the email once', async t => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'log', () => {});
  const dir = tempDir(t);
  await partialCrash(t, dir, toolCall('a-2', 'submit_service_request', intake));
  const second = await fixture(t, { dir, extra: twoNumbers });
  const later = Date.now() + 2 * 3600000;
  assert.deepEqual(await second.app.sweepOutbox(later), []);
  assert.equal(second.sent.length, 0, 'the outbox drops the stale row and sends nothing');
  assert.notEqual(officeAlert(dir), 'sent', 'nothing has been finished yet');
  const outcomes = [];
  for (let i = 0; i < 8; i++) outcomes.push(...(await Promise.all([second.app.sweepOutbox(later + i * MIN), second.app.sweepOfficeRetries(later + i * MIN)]))[1]);
  assert.deepEqual(outcomes, ['sent']);
  assert.equal(perTo(second, '+15550000001'), 0);
  assert.equal(perTo(second, '+15550000002'), 1); assert.equal(perTo(second, 'office@example.com'), 1);
  assert.match(second.sms()[0].body.text, /^Anchorline AI: \(delayed \d+ min\) New call/);
  assert.equal(retryRow(dir, 'a-2').done, 'sent');
  assert.equal(officeAlert(dir), 'sent_after_retry');
});

test('a stale submit with a long issue, sent by the office retry sweep: the delayed SMS is at most 302 characters with the STOP footer', async t => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'log', () => {});
  const dir = tempDir(t);
  await crashMidSend(t, dir, { cut: toolCall('a-3', 'submit_service_request', { ...intake, issue: 'Slow drain in the kitchen and the basement '.repeat(20) }) });
  const second = await fixture(t, { dir });
  assert.deepEqual(await second.app.sweepOfficeRetries(Date.now() + 3 * 3600000), ['sent']);
  assert.equal(second.sms().length, 1);
  const text = second.sms()[0].body.text;
  assert.ok(text.length <= 302, `${text.length} characters`);
  assert.match(text, /^Anchorline AI: \(delayed \d+ min\) New call - Gold Star Plumbing\n/);
  assert.match(text, /\nReply STOP to opt out$/);
});

test('email X fails, the caller corrects it to Y, then submit is retried: Y gets exactly one confirmation', async t => {
  let failX = true;
  const { post, emails } = await fixture(t, { behave: (url, body) => body.to?.[0] === 'x@example.org' && failX ? 500 : 200 });
  const first = await post(toolCall('c-1', 'submit_service_request', { ...intake, email: 'x@example.org', email_confirmed: true }, 's1'));
  assert.equal(first.caller_email, 'needs_review');
  assert.equal((await post(email('c-1', 'y@example.org', 'e1'))).caller_email, 'accepted');
  failX = false;
  const retry = await post(toolCall('c-1', 'submit_service_request', { ...intake, email: 'x@example.org', email_confirmed: true }, 's1'));
  assert.equal(retry.caller_email, 'accepted');
  const to = address => emails().filter(e => e.body.to[0] === address);
  assert.equal(to('y@example.org').length, 1, 'the corrected address gets one confirmation');
  assert.deepEqual(to('x@example.org').map(e => e.key), [`${first.request_id}-caller`], 'the first address keeps the v1.5 key and is not re-sent');
});

test('a retried urgent submit after Vapi refused the ring does not report the alert as sent', async t => {
  let vapiDown = true;
  const urgent = { ALERT_ROUTES: JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'], call: ['+15550000009'] } }),
    VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'phone-1' };
  const { post, sent, sms } = await fixture(t, { extra: urgent, behave: url => url.includes('vapi') && vapiDown ? 500 : 200 });
  const args = { ...intake, issue: 'URGENT - burst pipe' };
  assert.equal((await post(toolCall('v-1', 'submit_service_request', args))).office_alert, 'needs_review');
  vapiDown = false;
  const retry = await post(toolCall('v-1', 'submit_service_request', args));
  assert.equal(retry.office_alert, 'needs_review', 'nobody was rung: the stored ring outcome (not_placed) counts');
  assert.equal(sent.filter(s => s.url.includes('vapi')).length, 1, 'the ring is never placed twice');
  assert.equal(sms().length, 1);
});

test('a submit retry running alongside the office retry never overwrites sent_after_retry', async t => {
  let down = true;
  // The retry reads the stored result first; the office retry joins its slow alert sends and stores sent_after_retry;
  // the retry's slower caller receipt finishes last and must not write its stale copy of office_alert back.
  const { app, post, dir } = await fixture(t, { behave: async (url, body) => {
    if (!down) await settleLater(body.to?.[0] === 'linda@example.org' ? 600 : 300);
    return down ? 500 : 200;
  } });
  const args = { ...intake, email: 'linda@example.org', email_confirmed: true };
  await post(toolCall('j-1', 'submit_service_request', args));
  down = false;
  const retrying = post(toolCall('j-1', 'submit_service_request', args));
  await settleLater(100);
  assert.deepEqual(await app.sweepOfficeRetries(Date.now() + MIN + 1000), ['sent']);
  const retry = await retrying;
  const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  const stored = JSON.parse(db.prepare('SELECT result FROM requests').get().result); db.close();
  assert.equal(stored.office_alert, 'sent_after_retry'); assert.equal(stored.caller_email, 'accepted');
  assert.equal(retry.office_alert, 'sent_after_retry', 'the retry reports what is stored');
});

test('office retries under way, then a Vapi retry delivers: the office retry is closed at once and sends nothing more', async t => {
  let down = true;
  const { app, post, dir, sent } = await fixture(t, { behave: (url, body) => down && (url.includes('telnyx') || body.to?.[0] === 'office@example.com') ? 500 : 200 });
  await post(toolCall('p-11', 'submit_service_request', intake));
  const now = Date.now();
  await app.sweepOfficeRetries(now + MIN + 1000); await app.sweepOfficeRetries(now + 2 * MIN + 1000);
  assert.equal(retryRow(dir, 'p-11').attempts, 2);
  down = false;
  assert.equal((await post(toolCall('p-11', 'submit_service_request', intake))).office_alert, 'sent');
  assert.equal(retryRow(dir, 'p-11').done, 'sent', 'closed by the Vapi retry, not left armed');
  const before = sent.length;
  for (let i = 3; i < 12; i++) await app.sweepOfficeRetries(now + i * MIN + 1000);
  assert.equal(sent.length, before);
});

test('a confirmation to A cut off by a restart is never sent once the caller corrected it to B', async t => {
  const dir = tempDir(t);
  await crashMidSend(t, dir, { before: f => f.post(toolCall('p-12', 'submit_service_request', intake)), cut: email('p-12', 'a@example.org', 'e1') });
  const second = await fixture(t, { dir });
  await second.post(email('p-12', 'b@example.org', 'e2'));
  const swept = await second.app.sweepOutbox(Date.now() + 31000);
  assert.equal(swept.length, 1);
  const late = await second.post(email('p-12', 'a@example.org', 'e1'));
  assert.equal(late.caller_email, 'superseded');
  const to = address => second.emails().filter(e => e.body.to[0] === address).length;
  assert.equal(to('a@example.org'), 0); assert.equal(to('b@example.org'), 1);
});

test('the same toolCall id with different arguments is refused, nothing appended or sent', async t => {
  const { post, saved, sms } = await fixture(t);
  await post(toolCall('p-6', 'submit_service_request', intake));
  assert.equal((await post(note('p-6', 'Gate 1', 'same'))).note_added, true);
  const before = sms().length;
  const clash = await post(note('p-6', 'Gate 2', 'same'));
  assert.equal(clash.saved, false); assert.equal(clash.retryable, false);
  assert.deepEqual(saved('p-6').notes, ['Gate 1']); assert.equal(sms().length, before);
  assert.equal((await post(email('p-6', 'a@example.org', 'same-e'))).caller_email, 'accepted');
  assert.equal((await post(email('p-6', 'b@example.org', 'same-e'))).saved, false);
  assert.equal(saved('p-6').email, 'a@example.org');
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
