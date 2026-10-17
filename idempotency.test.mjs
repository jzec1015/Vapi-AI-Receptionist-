import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp, alertText, NOT_SAVED_SAY, NO_REQUEST_SAY, UNCONFIRMED_SAY, notSavedNote, notSavedSay } from './server.mjs';

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

// A toolCall id reused with different arguments: see 'a toolCall id the model reuses for a different note or email'.

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

test('outbox rows retrying while Telnyx and Resend hang never delay a held urgent ring: it goes on the same sweep tick as with no hang', async t => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const env = { ALERT_ROUTES: JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'], call: ['+15550000009'], digest: false } }),
    VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'from-line' };
  // Returns when (ms after the restart, on the mocked clock) the held ring was placed, or null if not within 40 s.
  async function ringTime(hang) {
    const dir = tempDir(t);
    const first = await fixture(t, { dir, extra: env });
    await first.post(toolCall('b-1', 'submit_service_request', intake, 'tc-s'));
    for (let i = 0; i < 4; i++) await first.post(note('b-1', `Gate code ${i}`, `tc-n${i}`));
    await first.stop();
    // Four note alerts left unsent (outbox rows due now), and a missed transfer whose held ring is due at +7 s.
    const base = Date.now();
    const db = new DatabaseSync(join(dir, 'requests.sqlite'));
    try {
      db.exec(`DELETE FROM deliveries WHERE ref LIKE '%-alert-note-%'; UPDATE tool_calls SET result = json_set(result, '$.office_alert', 'pending') WHERE name = 'add_request_note'`);
      for (const r of db.prepare("SELECT call_id, name, tool_call_id, args_key FROM tool_calls WHERE name = 'add_request_note'").all())
        db.prepare('INSERT OR REPLACE INTO outbox (ref, kind, call_id, tool_call_id, args_key, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?, 0)')
          .run(`${r.name}\n${r.call_id}\n${r.tool_call_id}\n${r.args_key}`, r.name, r.call_id, r.tool_call_id, r.args_key, base);
      assert.equal(db.prepare('SELECT count(*) n FROM outbox').get().n, 4);
      db.prepare("INSERT INTO transfers VALUES ('b-1', 'client-a', 'pending', ?, ?)").run(base + 7000, new Date(base).toISOString());
    } finally { db.close(); }
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: base });
    try {
      const rings = [];
      const hung = [];
      const send = (url, init) => {
        if (url === 'https://api.vapi.ai/call') { rings.push(Date.now() - base); return Promise.resolve(Response.json({ id: 'v1' })); }
        if (url.startsWith('https://api.vapi.ai/')) return Promise.resolve(new Response('{}', { status: 404 }));
        if (!hang) return Promise.resolve(new Response('{}', { status: 200 }));
        hung.push(url); // Telnyx or Resend hangs (until its 8 s abort, which never comes on this clock)
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timeout'))));
      };
      const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ...alertEnv, ...env }, send);
      try {
        for (let tick = 1; tick <= 8 && !rings.length; tick++) { t.mock.timers.tick(5000); await settleLater(60); }
        if (hang) assert.ok(hung.length > 0, 'the outbox sweep is hanging on a provider');
        return rings[0] ?? null;
      } finally { app.close(); }
    } finally { t.mock.timers.reset(); }
  }
  const control = await ringTime(false);
  const hung = await ringTime(true);
  assert.equal(control, 10000, 'with no hang the ring goes on the first 5 s tick after it is due');
  assert.equal(hung, control, `with providers hanging the ring went at ${hung} ms instead of ${control} ms`);
});

test('a 7am digest send that hangs never delays a held urgent ring: it goes on the same sweep tick as with no hang', async t => {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
  const env = { ALERT_ROUTES: JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'], call: ['+15550000009'] } }),
    VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'from-line' };
  const base = Date.parse('2026-10-16T12:05:00Z'); // 7:05am in Chicago: the digest is due
  // Returns when (ms after the restart, on the mocked clock) the held ring was placed, or null if not within 40 s.
  async function ringTime(hang) {
    const dir = tempDir(t);
    const first = await fixture(t, { dir, extra: env });
    await first.post(toolCall('d-1', 'submit_service_request', intake, 'tc-s'));
    await first.stop();
    const db = new DatabaseSync(join(dir, 'requests.sqlite'));
    try { db.prepare("INSERT INTO transfers VALUES ('d-1', 'client-a', 'pending', ?, ?)").run(base + 7000, new Date(base).toISOString()); }
    finally { db.close(); }
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: base });
    try {
      const rings = [];
      const digests = [];
      const send = (url, init) => {
        if (url === 'https://api.vapi.ai/call') { rings.push(Date.now() - base); return Promise.resolve(Response.json({ id: 'v1' })); }
        if (url.startsWith('https://api.vapi.ai/')) return Promise.resolve(new Response('{}', { status: 404 }));
        const digest = String(init.headers?.['Idempotency-Key'] || '').startsWith('digest-');
        if (digest) digests.push(url);
        if (!hang || !digest) return Promise.resolve(new Response('{}', { status: 200 }));
        // The digest send hangs (until its abort, which never comes on this clock)
        return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timeout'))));
      };
      const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ...alertEnv, ...env }, send);
      try {
        for (let tick = 1; tick <= 8 && !rings.length; tick++) { t.mock.timers.tick(5000); await settleLater(60); }
        assert.ok(digests.length > 0, 'the 7am digest went out during the test');
        return rings[0] ?? null;
      } finally { app.close(); }
    } finally { t.mock.timers.reset(); }
  }
  const control = await ringTime(false);
  const hung = await ringTime(true);
  assert.equal(control, 10000, 'with no hang the ring goes on the first 5 s tick after it is due');
  assert.equal(hung, control, `with the digest send hanging the ring went at ${hung} ms instead of ${control} ms`);
});

// Every saved:false result of add_request_note / add_customer_email carries ONE exact line to speak (say) and a note that
// begins "Say exactly the say line and nothing else about this.", so gpt-4.1 does not improvise "I'll note that...", "The
// team will see...", or speak a line the note forbids. The fields already there stay.
// note-server-retry: the server retries a write that throws itself, so every failure that reaches the model, the first
// and every later one, gets the not-saved line and "do not call it again" (gpt-4.1 never made the same-reply retry the
// old first-failure trouble line asked for). "No saved request yet" and an unconfirmed email keep their own lines.
const UNCONFIRMED = 'Not added: spell the email back letter by letter and get a clear yes first.';
const SAY_ONLY = 'Say exactly the say line and nothing else about this.';
// Every note gives other steps than the prompt's THE ONE RULE, and says so (it was obeyed over the note on Oct 17).
const REPLACES = "For this result, follow this note instead of THE ONE RULE's failed-save steps (trouble line, retry, closing line), and speak only the lines it gives.";
const NEVER = `Never say "I'll note that", "I'll let the team know", "I'll pass that on", "I've added that" or anything similar. ` +
  'Other than the exact lines given here, never say the team will see, have, know or get this detail.';
const TROUBLE = "I'm having trouble saving that, one moment.";
const NO_REQUEST = 'No saved request yet; save the request first';
// The exception (she already said the submit could not be saved) opens the note; the normal steps follow "Otherwise:".
const nojobNote = name => `${SAY_ONLY} If earlier in this call you already told the caller "I'm sorry, I couldn't save that", do not say ` +
  `the say line and do not call submit_service_request or ${name} again; say only "Mention that when the team calls you, so they have it." ` +
  `Otherwise: ${REPLACES} NOT saved: nothing was noted, added or passed on. There is no saved job yet, so no team call is set up: ` +
  `never say the team will call or call back about this. Do not call ${name} again before the job is saved. ` +
  'Carry on with the call and save with submit_service_request at the point THE PHONE NUMBER RULE, item 6 and WRAPPING UP ' +
  `say to. Only after that returns saved true, call ${name} again with the same detail, unless it is already in what you ` +
  `saved. ${NEVER}`;
const nojobNormal = text => text.split(' Otherwise: ')[1];
const stopNote = `${SAY_ONLY} ${REPLACES} NOT saved: nothing was noted, added or passed on. Do not call it again. ${NEVER}`;
const confirmNote = `${SAY_ONLY} ${REPLACES} NOT saved: the email is not confirmed yet. Then spell the email back letter by letter, and stop and wait for the caller's clear yes. ` +
  'Only after they say yes, call add_customer_email again with confirmed_after_spelling_back true. Never set it true without that yes, and never call ' +
  'again before the caller speaks. If they say it\'s wrong, ask them to spell just that part again, nice and slow, and read it back again, as you did ' +
  `before. Only if they won't or can't confirm it, say only "Mention that when the team calls you, so they have it." ${NEVER}`;
// The exact line each kind speaks. kind: 'stop' (any failed write or bad arguments: the not-saved line, no retry),
// 'confirm' (unconfirmed email) or 'nojob' (no saved request yet: the save-the-job-first note).
const SAYS = { stop: 'Mention that when the team calls you, so they have it.', confirm: 'Let me spell that back to make sure I have it.',
  nojob: "Okay, let's get the rest of your details first." };
const notSaved = (result, name, error, kind = 'stop') => {
  assert.equal(result.saved, false); assert.equal(result.retryable, false); assert.equal(result.error, error);
  if (kind === 'nojob') assert.equal(result.error, NO_REQUEST);
  assert.equal(result.say, SAYS[kind]);
  assert.equal(result.note, { stop: stopNote, confirm: confirmNote, nojob: nojobNote(name) }[kind]);
  assert.deepEqual(Object.keys(result), ['saved', 'retryable', 'error', 'say', 'note']);
};
const noCall = (name, args) => ({ message: { type: 'tool-calls', toolCallList: [{ id: 'tc-x', function: { name, arguments: args } }] } });
const failTrigger = (dir, table, on = 'INSERT') => { const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  try { db.exec(`CREATE TRIGGER fail_${table} BEFORE ${on} ON ${table} BEGIN SELECT RAISE(ABORT, 'disk full'); END`); } finally { db.close(); } };
const hasTable = (dir, table) => { const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table); } finally { db.close(); } };

test('every saved:false add_request_note path gets its say line and note: no job yet the no-job pair, any other the not-saved line and no retry', async t => {
  const { post, dir, saved, sms } = await fixture(t);
  const N = 'add_request_note';
  const fresh = async id => { await post(toolCall(id, 'submit_service_request', intake, 'tc-submit')); return id; };
  notSaved(await post(noCall(N, { note: 'Gate code 1' })), N, 'Missing Vapi call, chat or session ID');
  notSaved(await post(note('zn-1', 'Gate code 1', 'tc-1')), N, 'No saved request yet; save the request first', 'nojob');
  notSaved(await post(note(await fresh('zn-2'), '   ', 'tc-2')), N, 'Missing or invalid note');
  notSaved(await post(note(await fresh('zn-3'), 'x'.repeat(1001), 'tc-3')), N, 'Missing or invalid note');
  notSaved(await post(toolCall(await fresh('zn-4'), N, {}, 'tc-4')), N, 'Missing or invalid note');
  notSaved(await post(toolCall(await fresh('zn-5'), N, '{not json', 'tc-5')), N, 'Unable to add note');
  // A write that throws on every try: the not-saved line, and nothing saved or sent.
  const before = saved(await fresh('zn-7')), smsBefore = sms().length;
  failTrigger(dir, 'tool_calls');
  notSaved(await post(note('zn-7', 'Back door code 9', 'tc-7')), N, 'Unable to add note');
  assert.deepEqual(saved('zn-7'), before); assert.equal(sms().length, smsBefore);
});

test('every saved:false add_customer_email path gets its say line and note: no job yet the no-job pair, any other the not-saved line and no retry', async t => {
  const { post, dir, saved, emails } = await fixture(t);
  const E = 'add_customer_email';
  const fresh = async id => { await post(toolCall(id, 'submit_service_request', intake, 'tc-submit')); return id; };
  notSaved(await post(noCall(E, { email: 'a@example.org', confirmed_after_spelling_back: true })), E, 'Missing Vapi call, chat or session ID');
  notSaved(await post(email('ze-1', 'a@example.org', 'tc-1')), E, 'No saved request yet; save the request first', 'nojob');
  notSaved(await post(email(await fresh('ze-2'), 'not-an-email', 'tc-2')), E, 'Invalid email');
  notSaved(await post(email(await fresh('ze-3'), `${'a'.repeat(250)}@example.org`, 'tc-3')), E, 'Invalid email');
  notSaved(await post(toolCall(await fresh('ze-4'), E, '{not json', 'tc-4')), E, 'Unable to add email');
  const before = saved(await fresh('ze-6')), emailsBefore = emails().length;
  failTrigger(dir, 'tool_calls');
  notSaved(await post(email('ze-6', 'c@example.org', 'tc-6')), E, 'Unable to add email');
  assert.deepEqual(saved('ze-6'), before); assert.equal(emails().length, emailsBefore);
});

test('a toolCall id the model reuses for a different note or email is saved as its own change: no model retry needed', async t => {
  const { post, dir, saved, sms, emails } = await fixture(t);
  await post(toolCall('zu-1', 'submit_service_request', intake, 'tc-submit'));
  const smsBefore = sms().length;
  const a = await post(note('zu-1', 'Gate 1', 'same'));
  const b = await post(note('zu-1', 'Gate 2', 'same'));
  for (const r of [a, b]) { assert.equal(r.note_added, true); assert.equal(r.duplicate, undefined); assert.equal(r.office_alert, 'sent'); }
  assert.deepEqual(saved('zu-1').notes, ['Gate 1', 'Gate 2']);
  assert.equal(sms().length - smsBefore, 2); assert.equal(noteAlerts(emails).length, 2);
  // Each is keyed by id AND text, so a re-send of either (a Vapi retry, or the model repeating it) is that one's duplicate.
  assert.deepEqual(await post(note('zu-1', 'Gate 1', 'same')), { ...a, duplicate: true });
  assert.deepEqual(await post(note('zu-1', 'Gate 2', 'same')), { ...b, duplicate: true });
  assert.deepEqual(saved('zu-1').notes, ['Gate 1', 'Gate 2']); assert.equal(noteAlerts(emails).length, 2);
  assert.deepEqual(toolRows(dir, 'zu-1', 'add_request_note'), { tools: 2, outbox: 0 });
  // The same for emails: the corrected address is saved and confirmed, once.
  const x = await post(email('zu-1', 'a@example.org', 'same-e')), y = await post(email('zu-1', 'b@example.org', 'same-e'));
  assert.equal(x.caller_email, 'accepted'); assert.equal(y.caller_email, 'accepted'); assert.equal(y.duplicate, undefined);
  assert.equal(saved('zu-1').email, 'b@example.org');
  const count = emails().length;
  assert.deepEqual(await post(email('zu-1', 'b@example.org', 'same-e')), { ...y, duplicate: true });
  assert.equal(emails().length, count); assert.deepEqual(toolRows(dir, 'zu-1', 'add_customer_email'), { tools: 2, outbox: 0 });
});

test('an unconfirmed email always gets the wait-for-yes note (with the re-spell steps); a failure after it gets the not-saved line', async t => {
  const { post } = await fixture(t);
  const E = 'add_customer_email';
  await post(toolCall('zc-1', 'submit_service_request', intake, 'tc-submit'));
  notSaved(await post(toolCall('zc-1', E, { email: 'a@example.org', confirmed_after_spelling_back: false }, 'tc-1')), E, UNCONFIRMED, 'confirm');
  notSaved(await post(toolCall('zc-1', E, { email: 'a@example.org' }, 'tc-2')), E, UNCONFIRMED, 'confirm');
  notSaved(await post(toolCall('zc-1', E, { email: 'a@example.org', confirmed_after_spelling_back: 'true' }, 'tc-3')), E, UNCONFIRMED, 'confirm');
  notSaved(await post(email('zc-1', 'nope', 'tc-4')), E, 'Invalid email');
  notSaved(await post(toolCall('zc-1', E, { email: 'a@example.org', confirmed_after_spelling_back: false }, 'tc-6')), E, UNCONFIRMED, 'confirm');
  assert.match(confirmNote, /If they say it's wrong, ask them to spell just that part again, nice and slow, and read it back again/);
  assert.doesNotMatch(confirmNote.replace(REPLACES, ''), /trouble|once more|same reply/);
});

test('no failure count: the first failure and every later one (after a save, a re-sent id, a restart, in chat) get the not-saved line, and a model that calls again anyway can still save', async t => {
  const dir = tempDir(t);
  const N = 'add_request_note', E = 'add_customer_email';
  const first = await fixture(t, { dir });
  await first.post(toolCall('zk-1', 'submit_service_request', intake, 'tc-submit'));
  for (const id of ['tc-1', 'tc-1', 'tc-2']) notSaved(await first.post(note('zk-1', '', id)), N, 'Missing or invalid note');
  notSaved(await first.post(email('zk-1', 'nope', 'tc-3')), E, 'Invalid email');
  assert.equal((await first.post(note('zk-1', 'Gate 0', 'tc-4'))).note_added, true);
  notSaved(await first.post(note('zk-1', '', 'tc-5')), N, 'Missing or invalid note');
  await first.stop();
  const second = await fixture(t, { dir });
  notSaved(await second.post(note('zk-1', '', 'tc-6')), N, 'Missing or invalid note');
  assert.equal((await second.post(note('zk-1', 'Gate 1', 'tc-7'))).note_added, true);
  const chat = (id, name, args) => ({ message: { type: 'tool-calls', chat: { id: 'c-1' }, toolCallList: [{ id, function: { name, arguments: args } }] } });
  assert.equal((await second.post(chat('t0', 'submit_service_request', intake))).saved, true);
  for (const id of ['t1', 't2']) notSaved(await second.post(chat(id, N, { note: '' })), N, 'Missing or invalid note');
  assert.deepEqual(second.saved('zk-1').notes, ['Gate 0', 'Gate 1']);
  // The old loop-guard table is never made on a new database.
  assert.equal(hasTable(dir, 'tool_failures'), false);
});

test('run 4: a note and an email that failed before the request was saved get the no-job note, then save once the request is saved', async t => {
  const { post } = await fixture(t);
  const N = 'add_request_note', E = 'add_customer_email';
  notSaved(await post(note('zs-1', 'Gate 1', 'n1')), N, NO_REQUEST, 'nojob');
  notSaved(await post(note('zs-1', 'Gate 1', 'n2')), N, NO_REQUEST, 'nojob');
  notSaved(await post(email('zs-1', 'a@example.org', 'e1')), E, NO_REQUEST, 'nojob');
  // A refused submit (saved:false) saves nothing, so the note still gets the save-the-job-first note.
  const refused = await post(toolCall('zs-1', 'submit_service_request', { ...intake, email_confirmed: true, email: 'bad', email_status: 'confirmed' }, 's0'));
  assert.equal(refused.saved, false);
  notSaved(await post(note('zs-1', 'Gate 1', 'n3')), N, NO_REQUEST, 'nojob');
  assert.equal((await post(toolCall('zs-1', 'submit_service_request', intake, 's1'))).saved, true);
  notSaved(await post(note('zs-1', '', 'n4')), N, 'Missing or invalid note');
  notSaved(await post(email('zs-1', 'bad', 'e2')), E, 'Invalid email');
  assert.equal((await post(note('zs-1', 'Gate 1', 'n5'))).note_added, true);
});

test('"No saved request yet" three times in a row: the save-the-job-first note every time, never the not-saved line outside its exception', async t => {
  const { post } = await fixture(t);
  const N = 'add_request_note', E = 'add_customer_email';
  for (const id of ['n1', 'n2', 'n3']) {
    const result = await post(note('zj-1', 'Gate 1', id));
    notSaved(result, N, NO_REQUEST, 'nojob');
    // Only the exception (she already said the submit could not be saved) names the not-saved line.
    assert.doesNotMatch(result.say + nojobNormal(result.note), /when the team calls|Do not call it again|trouble saving/);
  }
  for (const id of ['e1', 'e2', 'e3']) notSaved(await post(email('zj-1', 'a@example.org', id)), E, NO_REQUEST, 'nojob');
  assert.equal((await post(toolCall('zj-1', 'submit_service_request', intake, 'tc-submit'))).saved, true);
  notSaved(await post(note('zj-1', '', 'n4')), N, 'Missing or invalid note');
  notSaved(await post(email('zj-1', 'nope', 'e4')), E, 'Invalid email');
});

test('saved:true note and email results, and their duplicates, are unchanged: no say or note fields', async t => {
  const { post } = await fixture(t);
  await post(toolCall('z-3', 'submit_service_request', intake, 'tc-submit'));
  const added = await post(note('z-3', 'Gate code 4471', 'tc-n'));
  assert.deepEqual(Object.keys(added), ['saved', 'request_id', 'note_added', 'office_alert']);
  assert.equal(added.saved, true); assert.equal(added.office_alert, 'sent');
  const again = await post(note('z-3', 'Gate code 4471', 'tc-n'));
  assert.deepEqual(again, { ...added, duplicate: true });
  const mail = await post(email('z-3', 'linda@example.org', 'tc-e'));
  assert.deepEqual(Object.keys(mail), ['saved', 'request_id', 'email_added', 'caller_email']);
  assert.equal(mail.saved, true); assert.equal(mail.caller_email, 'accepted');
  assert.deepEqual(await post(email('z-3', 'linda@example.org', 'tc-e')), { ...mail, duplicate: true });
});

test('submit_service_request and other tools never get the note/email say line', async t => {
  const { post } = await fixture(t);
  const refused = await post(toolCall('z-4', 'submit_service_request', { ...intake, email_confirmed: true, email: 'bad', email_status: 'confirmed' }));
  assert.equal(refused.saved, false); assert.equal(refused.say, undefined); assert.equal(refused.note, undefined);
  const noId = await post(noCall('submit_service_request', intake));
  assert.equal(noId.saved, false); assert.equal(noId.say, undefined); assert.equal(noId.note, undefined);
  const unknown = await post(toolCall('z-4', 'some_other_tool', {}));
  assert.equal(unknown.saved, false); assert.equal(unknown.say, undefined); assert.equal(unknown.note, undefined);
});

test('the not-saved note text: retryable is never consulted; only no-job and unconfirmed differ from the stop note', () => {
  for (const name of ['add_request_note', 'add_customer_email']) {
    for (const result of [{ saved: false, retryable: true, error: 'Unable to add note' }, { saved: false, retryable: false, error: 'Unable to add note' }, { saved: false, error: 'x' }, {}])
      assert.equal(notSavedNote(name, result), stopNote);
    assert.equal(notSavedNote(name, { saved: false, retryable: false, error: NO_REQUEST }), nojobNote(name));
  }
  assert.equal(notSavedNote('add_customer_email', { saved: false, retryable: false, error: UNCONFIRMED }), confirmNote);
  assert.doesNotMatch(nojobNormal(nojobNote('x')), /when the team calls|so they have it|Do not call it again|that they will have it/);
  // It points to the prompt's rules for when to save and never restates them (main and emma-social-1017 differ: the
  // social fallback for a number that can't be confirmed, the address read-back), and never says to save right away.
  assert.match(nojobNote('x'), /save with submit_service_request at the point THE PHONE NUMBER RULE, item 6 and WRAPPING UP say to\./);
  assert.doesNotMatch(nojobNote('x'), /read-back|read back|save the job first|right away|callback number/i);
  // No note asks for a retry in the same reply any more.
  for (const text of [stopNote, confirmNote, nojobNote('x')]) assert.doesNotMatch(text, /once more|same reply|never stop after the say line/);
});

// note-say-dedupe: gpt-4.1 broke free-text notes in real runs (Oct 17), so every failure type carries one exact line.
test('each not-saved failure type speaks its one exact line, and every note says to speak only it and claims nothing for the team', () => {
  assert.equal(NO_REQUEST_SAY, "Okay, let's get the rest of your details first.");
  assert.equal(UNCONFIRMED_SAY, 'Let me spell that back to make sure I have it.');
  assert.equal(NOT_SAVED_SAY, 'Mention that when the team calls you, so they have it.');
  assert.equal(notSavedSay({ error: NO_REQUEST }), NO_REQUEST_SAY);
  assert.equal(notSavedSay({ error: UNCONFIRMED }), UNCONFIRMED_SAY);
  for (const error of ['Invalid email', 'Missing or invalid note', 'Unable to add note', 'Unable to add email', 'Missing Vapi call, chat or session ID', 'x'])
    assert.equal(notSavedSay({ error }), NOT_SAVED_SAY);
  for (const name of ['add_request_note', 'add_customer_email'])
    for (const error of [NO_REQUEST, UNCONFIRMED, 'x']) {
      const text = notSavedNote(name, { error });
      const opens = error === NO_REQUEST ? `${SAY_ONLY} If earlier in this call` : `${SAY_ONLY} ${REPLACES} NOT saved`;
      assert.ok(text.startsWith(opens), text); assert.ok(text.endsWith(NEVER), text);
      if (error === NO_REQUEST) assert.ok(nojobNormal(text).startsWith(`${REPLACES} NOT saved`), text);
      assert.ok(!text.includes(TROUBLE), text);
    }
  // The no-job note opens with its one exception (she already said the submit could not be saved, so the team is calling
  // back: the not-saved line, no save tool), then "Otherwise:" and the normal steps, which never name the not-saved line,
  // a team call or "they will have it", so nothing after the exception contradicts it. Nothing follows the steps but NEVER.
  const [exception, normal] = nojobNote('x').split(' Otherwise: ');
  assert.equal(exception, `${SAY_ONLY} If earlier in this call you already told the caller "I'm sorry, I couldn't save that", do not say the ` +
    'say line and do not call submit_service_request or x again; say only "Mention that when the team calls you, so they have it."');
  assert.doesNotMatch(normal, /team calls you|so they have it|that they will have it|couldn't save/);
  assert.ok(normal.endsWith(`unless it is already in what you saved. ${NEVER}`));
  assert.match(stopNote, /Do not call it again/);
});

test('live: the say line per failure type; the trouble line never comes back from the server', async t => {
  const { post } = await fixture(t);
  const N = 'add_request_note', E = 'add_customer_email';
  assert.equal((await post(note('zy-1', 'Gate 1', 'n0'))).say, NO_REQUEST_SAY);
  await post(toolCall('zy-1', 'submit_service_request', intake, 'tc-submit'));
  assert.equal((await post(toolCall('zy-1', E, { email: 'a@example.org' }, 'e0'))).say, UNCONFIRMED_SAY);
  assert.equal((await post(note('zy-1', 'Gate 1', 'n1'))).note_added, true);
  const first = await post(note('zy-1', '', 'n2'));
  assert.equal(first.say, NOT_SAVED_SAY); notSaved(first, N, 'Missing or invalid note');
  assert.equal((await post(note('zy-1', 'Gate 1', 'n3'))).duplicate, true);
  const again = await post(note('zy-1', '', 'n4'));
  assert.equal(again.say, NOT_SAVED_SAY); notSaved(again, N, 'Missing or invalid note');
  assert.ok(![first, again].some(r => JSON.stringify(r).includes(TROUBLE)));
});

const toolRows = (dir, callId, name) => { const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  try { return { tools: db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE call_id = ? AND name = ?').get(callId, name).n,
    outbox: db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE call_id = ? AND kind = ?').get(callId, name).n }; } finally { db.close(); } };
const noteAlerts = emails => emails().filter(e => /-alert-note-/.test(e.key));

test('a note that repeats the last saved note on a new toolCall id (case and spacing ignored) is a duplicate: one note, one alert, no new row', async t => {
  const { post, dir, saved, sms, emails } = await fixture(t);
  await post(toolCall('zz-1', 'submit_service_request', intake, 'tc-submit'));
  const smsBefore = sms().length;
  const first = await post(note('zz-1', 'Gate code 4471', 'n1'));
  assert.equal(first.note_added, true); assert.equal(first.office_alert, 'sent'); assert.equal(first.duplicate, undefined);
  const smsAfter = sms().length;
  for (const [text, id] of [['Gate code 4471', 'n2'], ['  gate   CODE 4471 ', 'n3'], ['Gate code\n4471', 'n4']])
    assert.deepEqual(await post(note('zz-1', text, id)), { ...first, duplicate: true });
  assert.deepEqual(saved('zz-1').notes, ['Gate code 4471']);
  assert.equal(noteAlerts(emails).length, 1); assert.equal(sms().length, smsAfter); assert.ok(smsAfter > smsBefore);
  assert.deepEqual(toolRows(dir, 'zz-1', 'add_request_note'), { tools: 1, outbox: 0 });
  // A different text is a new note.
  assert.equal((await post(note('zz-1', 'Gate code 4472', 'n5'))).note_added, true);
  assert.equal(noteAlerts(emails).length, 2);
});

test('A, then B, then A again is three notes and three alerts (only the LAST saved note is deduped)', async t => {
  const { post, saved, emails } = await fixture(t);
  await post(toolCall('zz-2', 'submit_service_request', intake, 'tc-submit'));
  for (const [text, id] of [['Gate code 4471', 'n1'], ['Dog in the yard', 'n2'], ['Gate code 4471', 'n3']]) {
    const result = await post(note('zz-2', text, id));
    assert.equal(result.note_added, true); assert.equal(result.duplicate, undefined);
  }
  assert.deepEqual(saved('zz-2').notes, ['Gate code 4471', 'Dog in the yard', 'Gate code 4471']);
  assert.equal(noteAlerts(emails).length, 3);
  // And now A again is a repeat of the last one.
  assert.equal((await post(note('zz-2', 'gate code 4471', 'n4'))).duplicate, true);
  assert.equal(noteAlerts(emails).length, 3);
});

test('the last-note dedupe reads the database, so it holds after a restart', async t => {
  const dir = tempDir(t);
  const first = await fixture(t, { dir });
  await first.post(toolCall('zz-3', 'submit_service_request', intake, 'tc-submit'));
  const added = await first.post(note('zz-3', 'Back door code 9', 'n1'));
  assert.equal(added.note_added, true);
  await first.stop();
  const second = await fixture(t, { dir });
  assert.deepEqual(await second.post(note('zz-3', 'back door code 9', 'n2')), { ...added, duplicate: true });
  assert.equal(noteAlerts(second.emails).length, 0); assert.equal(second.sms().length, 0);
  assert.deepEqual(second.saved('zz-3').notes, ['Back door code 9']);
  assert.deepEqual(toolRows(dir, 'zz-3', 'add_request_note'), { tools: 1, outbox: 0 });
});

test('a note the request does not end with (e.g. written by a rolled-back build, no tool_calls row) is never deduped against an older row', async t => {
  const { post, dir, saved, emails } = await fixture(t);
  await post(toolCall('zz-4', 'submit_service_request', intake, 'tc-submit'));
  assert.equal((await post(note('zz-4', 'Gate 1', 'n1'))).note_added, true);
  const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  try { db.prepare("UPDATE requests SET details = json_set(details, '$.notes', json('[\"Gate 1\",\"Dog\"]')) WHERE call_id = 'zz-4'").run(); } finally { db.close(); }
  assert.equal((await post(note('zz-4', 'Gate 1', 'n2'))).note_added, true);
  assert.deepEqual(saved('zz-4').notes, ['Gate 1', 'Dog', 'Gate 1']);
  assert.equal(noteAlerts(emails).length, 2);
});

test('the same email as the last one add_customer_email saved (any case) is a duplicate: no second confirmation or row; a new address is not', async t => {
  const { post, dir, saved, emails } = await fixture(t);
  await post(toolCall('zz-5', 'submit_service_request', intake, 'tc-submit'));
  const mail = await post(email('zz-5', 'linda@example.org', 'e1'));
  assert.equal(mail.caller_email, 'accepted');
  const count = emails().length;
  assert.deepEqual(await post(email('zz-5', ' Linda@Example.org ', 'e2')), { ...mail, duplicate: true });
  assert.equal(emails().length, count); assert.equal(saved('zz-5').email, 'linda@example.org');
  assert.deepEqual(toolRows(dir, 'zz-5', 'add_customer_email'), { tools: 1, outbox: 0 });
  assert.equal((await post(email('zz-5', 'other@example.org', 'e3'))).email_added, true);
  assert.equal(saved('zz-5').email, 'other@example.org');
});

test('a repeat of the last note while its alert is still sending joins that send: it returns the final result, and one alert goes out', async t => {
  let hold = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  const { post, sent, emails } = await fixture(t, { behave: () => hold ? gate.then(() => 200) : 200 });
  await post(toolCall('zz-6', 'submit_service_request', intake, 'tc-submit'));
  const before = sent.length;
  hold = true;
  const first = post(note('zz-6', 'Gate code 4471', 'n1'));
  for (let i = 0; i < 100 && sent.length === before; i++) await settleLater(10);
  assert.ok(sent.length > before, 'the first note alert is on its way');
  let done = false;
  const repeat = post(note('zz-6', 'gate code 4471', 'n2')).then(r => { done = true; return r; });
  await settleLater(100);
  assert.equal(done, false, 'the repeat waits for the running send');
  release();
  const [a, b] = await Promise.all([first, repeat]);
  assert.equal(a.office_alert, 'sent'); assert.deepEqual(b, { ...a, duplicate: true });
  assert.equal(noteAlerts(emails).length, 1);
});

test('parallel repeats of one note on new toolCall ids: one note, one alert, the rest duplicates', async t => {
  const { post, saved, emails } = await fixture(t);
  await post(toolCall('zz-7', 'submit_service_request', intake, 'tc-submit'));
  const results = await Promise.all(['n1', 'n2', 'n3'].map(id => post(note('zz-7', 'Gate code 4471', id))));
  assert.equal(results.filter(r => r.note_added && !r.duplicate).length, 1);
  assert.equal(results.filter(r => r.duplicate).length, 2);
  assert.deepEqual(saved('zz-7').notes, ['Gate code 4471']); assert.equal(noteAlerts(emails).length, 1);
});

test('a note whose first attempt failed (nothing stored) is saved as new on the retry, never deduped', async t => {
  const { post, dir, saved, emails } = await fixture(t);
  await post(toolCall('zz-8', 'submit_service_request', intake, 'tc-submit'));
  failTrigger(dir, 'tool_calls');
  notSaved(await post(note('zz-8', 'Gate code 4471', 'n1')), 'add_request_note', 'Unable to add note');
  const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  try { db.exec('DROP TRIGGER fail_tool_calls'); } finally { db.close(); }
  const retry = await post(note('zz-8', 'Gate code 4471', 'n2'));
  assert.equal(retry.note_added, true); assert.equal(retry.duplicate, undefined);
  assert.deepEqual(saved('zz-8').notes, ['Gate code 4471']); assert.equal(noteAlerts(emails).length, 1);
});

test('emails A, B, A are three saves; only a repeat of the last one (any case) is a duplicate', async t => {
  const { post, saved } = await fixture(t);
  await post(toolCall('zz-9', 'submit_service_request', intake, 'tc-submit'));
  for (const [address, id] of [['a@example.org', 'e1'], ['b@example.org', 'e2'], ['a@example.org', 'e3']]) {
    const result = await post(email('zz-9', address, id));
    assert.equal(result.email_added, true); assert.equal(result.duplicate, undefined);
  }
  assert.equal((await post(email('zz-9', 'A@Example.org', 'e4'))).duplicate, true);
  assert.equal(saved('zz-9').email, 'a@example.org');
});

test('the server keeps no failed-submit count: two "email first" refusals, then a note, give the normal no-job result, and a valid submit still saves', async t => {
  const { post } = await fixture(t);
  const N = 'add_request_note';
  // A refusal the model fixes by asking the caller (not THE ONE RULE's give-up), twice in a row.
  const skipped = { ...intake, email_status: 'skipped_emergency' };
  for (const id of ['s1', 's2']) {
    const refused = await post(toolCall('zg-1', 'submit_service_request', skipped, id));
    assert.equal(refused.saved, false); assert.match(refused.error, /ask the caller for their email first/);
  }
  notSaved(await post(note('zg-1', 'Gate 1', 'n1')), N, NO_REQUEST, 'nojob');
  assert.equal((await post(toolCall('zg-1', 'submit_service_request', intake, 's3'))).saved, true);
  assert.equal((await post(note('zg-1', 'Gate 1', 'n2'))).note_added, true);
});

// note-server-retry: the server retries a note or email write that throws, inside the same request (addTool). Each test
// proves one try count from the server's own log line (tool-write ... try=N), so a test whose fault never fired fails.
const captureWarn = t => { const lines = [], warn = console.warn; console.warn = (...a) => { lines.push(a.join(' ')); };
  t.after(() => { console.warn = warn; }); return lines; };
const writeTries = (lines, name, callId) => lines.filter(l => l.startsWith(`tool-write name=${name} call=${callId} `));

// A trigger that fails INSERTs into tool_calls while fail_once has a row; clear() empties it.
const failInsertOnce = file => { const db = new DatabaseSync(file);
  try { db.exec(`CREATE TABLE fail_once (x); INSERT INTO fail_once VALUES (1);
    CREATE TRIGGER fail_insert BEFORE INSERT ON tool_calls WHEN EXISTS (SELECT 1 FROM fail_once) BEGIN SELECT RAISE(ABORT, 'disk full'); END`); } finally { db.close(); }
  return () => { const d = new DatabaseSync(file); try { d.exec('DELETE FROM fail_once'); } finally { d.close(); } }; };

test('a note write that fails fast once is retried by the server: saved true, one note, one row, one alert', async t => {
  const { post, dir, saved, sms, emails } = await fixture(t);
  await post(toolCall('zb-1', 'submit_service_request', intake, 'tc-submit'));
  const smsBefore = sms().length;
  const clear = failInsertOnce(join(dir, 'requests.sqlite'));
  const warn = captureWarn(t);
  // Cleared 50 ms in: after try 1 has thrown, before the 100 ms retry.
  setTimeout(clear, 50);
  const result = await post(note('zb-1', 'Gate code 4471', 'n1'));
  assert.equal(writeTries(warn, 'add_request_note', 'zb-1').length, 1);
  assert.equal(result.saved, true); assert.equal(result.note_added, true); assert.equal(result.office_alert, 'sent');
  assert.equal(result.duplicate, undefined); assert.equal(result.say, undefined);
  assert.deepEqual(saved('zb-1').notes, ['Gate code 4471']);
  assert.equal(sms().length - smsBefore, 1); assert.equal(noteAlerts(emails).length, 1);
  assert.deepEqual(toolRows(dir, 'zb-1', 'add_request_note'), { tools: 1, outbox: 0 });
});

test('silence bound: a write that waits out busy_timeout (real SQLITE_BUSY) is not tried again; the result comes back after one 5 s wait', async t => {
  const { post, dir, saved, sent } = await fixture(t);
  const N = 'add_request_note';
  await post(toolCall('zl-1', 'submit_service_request', intake, 'tc-submit'));
  const before = saved('zl-1'), sentBefore = sent.length;
  // Another connection holds the write lock for the whole request.
  const lock = new DatabaseSync(join(dir, 'requests.sqlite'));
  t.after(() => { if (lock.isTransaction) lock.exec('ROLLBACK'); lock.close(); });
  lock.exec('BEGIN IMMEDIATE');
  const warn = captureWarn(t), logs = [], log = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); }; t.after(() => { console.log = log; });
  const started = Date.now();
  const result = await post(note('zl-1', 'Gate code 4471', 'n1'));
  const elapsed = Date.now() - started;
  lock.exec('ROLLBACK');
  const tries = writeTries(warn, N, 'zl-1');
  assert.equal(tries.length, 1); assert.match(tries[0], /try=1 error=database_is_locked$/);
  // The server's own time for the request (its tool-call log line): one 5 s wait, no retry.
  const ms = Number(logs.find(l => l.startsWith(`tool-call name=${N} call=zl-1 `)).match(/ms=(\d+)$/)[1]);
  assert.ok(ms >= 5000 && ms < 6000, `one busy_timeout wait, no retry: ${ms} ms`);
  // Wall time may add one more 5 s freeze: a sweep timer (e.g. the digest) also hits the held lock, as on the base build.
  assert.ok(elapsed < 11000, `${elapsed} ms`);
  notSaved(result, N, 'Unable to add note');
  assert.deepEqual(saved('zl-1'), before); assert.equal(sent.length, sentBefore);
});

test('a concurrent copy of the same tool call (a Vapi re-send while the first waits to retry) joins it: one non-duplicate result, one note, row and alert', async t => {
  const { post, dir, saved, sms, emails } = await fixture(t);
  const N = 'add_request_note';
  await post(toolCall('zc-2', 'submit_service_request', intake, 'tc-submit'));
  const smsBefore = sms().length;
  const clear = failInsertOnce(join(dir, 'requests.sqlite'));
  const warn = captureWarn(t);
  const first = post(note('zc-2', 'Gate code 4471', 'n1'));
  // The copy arrives while the first sleeps before its retry; the fault clears before that retry.
  await settleLater(30);
  const copy = post(note('zc-2', 'Gate code 4471', 'n1'));
  setTimeout(clear, 30);
  const [a, b] = await Promise.all([first, copy]);
  assert.equal(writeTries(warn, N, 'zc-2').length, 1, 'only the first ran tries');
  assert.equal(a.note_added, true); assert.equal(a.duplicate, undefined);
  assert.deepEqual(b, { ...a, duplicate: true });
  assert.deepEqual(saved('zc-2').notes, ['Gate code 4471']);
  assert.equal(sms().length - smsBefore, 1); assert.equal(noteAlerts(emails).length, 1);
  assert.deepEqual(toolRows(dir, 'zc-2', N), { tools: 1, outbox: 0 });
});

test('A, B, A on one reused toolCall id is two notes: the third repeats a text that id saved, so it is taken as a Vapi re-send', async t => {
  const { post, saved } = await fixture(t);
  await post(toolCall('zr-2', 'submit_service_request', intake, 'tc-submit'));
  const a = await post(note('zr-2', 'Gate 1', 'same'));
  assert.equal((await post(note('zr-2', 'Gate 2', 'same'))).note_added, true);
  assert.deepEqual(await post(note('zr-2', 'Gate 1', 'same')), { ...a, duplicate: true });
  assert.deepEqual(saved('zr-2').notes, ['Gate 1', 'Gate 2']);
});

test('a note write that throws on every try: three tries in one request, then the not-saved line; no note, row, outbox or alert. Bad arguments are never retried', async t => {
  const { post, dir, saved, sent } = await fixture(t);
  const N = 'add_request_note';
  await post(toolCall('zf-1', 'submit_service_request', intake, 'tc-submit'));
  const sentBefore = sent.length, before = saved('zf-1');
  failTrigger(dir, 'tool_calls');
  const warn = captureWarn(t), started = Date.now();
  const result = await post(note('zf-1', 'Gate code 4471', 'n1'));
  notSaved(result, N, 'Unable to add note'); assert.equal(result.say, NOT_SAVED_SAY); assert.match(result.note, /Do not call it again\./);
  assert.deepEqual(writeTries(warn, N, 'zf-1').map(l => l.match(/try=(\d+)/)[1]), ['1', '2', '3']);
  assert.ok(Date.now() - started >= 500, 'the 100 ms and 400 ms waits ran');
  assert.deepEqual(saved('zf-1'), before); assert.equal(sent.length, sentBefore);
  assert.deepEqual(toolRows(dir, 'zf-1', N), { tools: 0, outbox: 0 });
  // A model that calls again anyway gets the same pair again.
  notSaved(await post(note('zf-1', 'Gate code 4471', 'n2')), N, 'Unable to add note');
  // Arguments only the model can fix come back at once, with no server retry.
  warn.length = 0;
  notSaved(await post(note('zf-1', '', 'n3')), N, 'Missing or invalid note');
  notSaved(await post(toolCall('zf-1', N, '{bad', 'n4')), N, 'Unable to add note');
  notSaved(await post(email('zf-1', 'nope', 'e1')), 'add_customer_email', 'Invalid email');
  assert.deepEqual(warn.filter(l => l.startsWith('tool-write')), []);
});

test('half-success: the write committed but delivery throws on every try. The result is saved (honest), with one note, row and alert; the outbox finishes without a resend', async t => {
  const { app, post, dir, saved, sms, emails } = await fixture(t);
  const N = 'add_request_note';
  await post(toolCall('zh-1', 'submit_service_request', intake, 'tc-submit'));
  const smsBefore = sms().length;
  // deliverTool's UPDATE of the stored result runs after the sends: the note is committed and its alert is out.
  failTrigger(dir, 'tool_calls', 'UPDATE');
  const warn = captureWarn(t);
  const result = await post(note('zh-1', 'Gate code 4471', 'n1'));
  assert.equal(writeTries(warn, N, 'zh-1').length, 3);
  assert.deepEqual(Object.keys(result), ['saved', 'request_id', 'note_added', 'office_alert']);
  assert.equal(result.saved, true); assert.equal(result.note_added, true); assert.equal(result.office_alert, 'pending');
  assert.deepEqual(saved('zh-1').notes, ['Gate code 4471']);
  assert.equal(sms().length - smsBefore, 1); assert.equal(noteAlerts(emails).length, 1);
  assert.deepEqual(toolRows(dir, 'zh-1', N), { tools: 1, outbox: 1 });
  // Once the fault clears, the outbox sweep finishes it through the ledger: nothing is sent twice.
  const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  try { db.exec('DROP TRIGGER fail_tool_calls'); } finally { db.close(); }
  await app.sweepOutbox(Date.now() + 120000);
  assert.equal(sms().length - smsBefore, 1); assert.equal(noteAlerts(emails).length, 1);
  assert.deepEqual(toolRows(dir, 'zh-1', N), { tools: 1, outbox: 0 });
  // A Vapi re-send of the same tool call gets the finished result, marked duplicate, and sends nothing.
  const again = await post(note('zh-1', 'Gate code 4471', 'n1'));
  assert.equal(again.duplicate, true); assert.equal(again.office_alert, 'sent');
  assert.equal(sms().length - smsBefore, 1); assert.deepEqual(saved('zh-1').notes, ['Gate code 4471']);
});

test('half-success once: delivery throws on the first try only. The server retry finishes it: saved, not marked duplicate, one note, row and alert', async t => {
  let onSend = () => {};
  const { post, dir, saved, sms, emails } = await fixture(t, { behave: (url, body) => { onSend(url, body); return 200; } });
  const N = 'add_request_note', file = join(dir, 'requests.sqlite');
  await post(toolCall('zo-1', 'submit_service_request', intake, 'tc-submit'));
  const smsBefore = sms().length;
  const db = new DatabaseSync(file);
  try { db.exec(`CREATE TABLE fail_once (x); INSERT INTO fail_once VALUES (1);
    CREATE TRIGGER fail_update BEFORE UPDATE ON tool_calls WHEN EXISTS (SELECT 1 FROM fail_once) BEGIN SELECT RAISE(ABORT, 'disk full'); END`); } finally { db.close(); }
  // The fault clears 50 ms after the note alert's SMS goes out: after try 1 has thrown, before the 100 ms retry.
  onSend = url => { if (url.includes('telnyx')) setTimeout(() => { const d = new DatabaseSync(file); try { d.exec('DELETE FROM fail_once'); } finally { d.close(); } }, 50); };
  const warn = captureWarn(t);
  const result = await post(note('zo-1', 'Gate code 4471', 'n1'));
  assert.equal(writeTries(warn, N, 'zo-1').length, 1);
  assert.deepEqual(Object.keys(result), ['saved', 'request_id', 'note_added', 'office_alert']);
  assert.equal(result.office_alert, 'sent'); assert.equal(result.note_added, true);
  assert.deepEqual(saved('zo-1').notes, ['Gate code 4471']);
  assert.equal(sms().length - smsBefore, 1); assert.equal(noteAlerts(emails).length, 1);
  assert.deepEqual(toolRows(dir, 'zo-1', N), { tools: 1, outbox: 0 });
});

test('an email write that throws once is retried by the server: one saved address, one confirmation', async t => {
  let onSend = () => {};
  const { post, dir, saved, emails } = await fixture(t, { behave: (url, body) => { onSend(url, body); return 200; } });
  const E = 'add_customer_email', file = join(dir, 'requests.sqlite');
  await post(toolCall('zo-2', 'submit_service_request', intake, 'tc-submit'));
  const db = new DatabaseSync(file);
  try { db.exec(`CREATE TABLE fail_once (x); INSERT INTO fail_once VALUES (1);
    CREATE TRIGGER fail_update BEFORE UPDATE ON tool_calls WHEN EXISTS (SELECT 1 FROM fail_once) BEGIN SELECT RAISE(ABORT, 'disk full'); END`); } finally { db.close(); }
  onSend = (url, body) => { if (body.to?.[0] === 'a@example.org') setTimeout(() => { const d = new DatabaseSync(file); try { d.exec('DELETE FROM fail_once'); } finally { d.close(); } }, 50); };
  const warn = captureWarn(t);
  const result = await post(email('zo-2', 'a@example.org', 'e1'));
  assert.equal(writeTries(warn, E, 'zo-2').length, 1);
  assert.deepEqual(Object.keys(result), ['saved', 'request_id', 'email_added', 'caller_email']);
  assert.equal(result.caller_email, 'accepted'); assert.equal(saved('zo-2').email, 'a@example.org');
  assert.equal(emails().filter(e => e.body.to[0] === 'a@example.org').length, 1);
  assert.deepEqual(toolRows(dir, 'zo-2', E), { tools: 1, outbox: 0 });
});
