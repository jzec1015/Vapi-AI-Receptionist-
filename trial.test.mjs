import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './server.mjs';
import { createApp as createV150 } from './fixtures/server-v1.5.0.mjs';

// Trial clients: route rows in the clients table, minute tracking and the one-time cap alert.
const key = 'synthetic-test-key-not-used-in-production';
const routes = JSON.stringify({ 'gold-star': { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'] } });
const baseEnv = { VAPI_WEBHOOK_SECRET: key, ALERT_ROUTES: routes, TELNYX_API_KEY: 'fixture-only', TELNYX_FROM: '+15550000000',
  RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com', OFFICE_EMAIL: 'jake@example.com' };
const intake = { name: 'Linda Harper', address: '48 Birch Road', issue: 'Kitchen faucet dripping', is_test: false, callback_phone: '6155550142', callback_read_back: true,
  email_status: 'declined' };
const call = (id, assistantId) => ({ id, assistantId, type: 'inboundPhoneCall', customer: { number: '+16155550100' } });
const toolCall = (id, assistantId, args = intake) => ({ message: { type: 'tool-calls', call: call(id, assistantId),
  toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } });
const report = (id, assistantId, durationSeconds) => ({ message: { type: 'end-of-call-report', durationSeconds, endedReason: 'customer-ended-call', call: call(id, assistantId) } });
const client = (id, fields = {}) => ({ id, assistant_id: `asst-${id}`, phone_number_id: `pn-${id}`, phone_number: '+16155550300', business: `Trial ${id} Plumbing`,
  owner_name: 'Pat Owner', owner_cell: '+16155550400', office_emails: '["desk@trial.example"]', alert_call: '["+16155550401"]', transfer: null,
  shop_number: '+16155550500', state: 'TN', status: 'active', trial_ends_at: '2026-10-29T00:00:00.000Z', created_at: '2026-10-15T00:00:00.000Z', ...fields });

async function fixture(t, env = {}, factory = createApp, dir = mkdtempSync(join(tmpdir(), 'trial-test-'))) {
  const sent = [];
  const send = async (url, init) => { sent.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : null }); return new Response('{}', { status: 200 }); };
  const app = factory({ DATA_DIR: dir, ...baseEnv, ...env }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const close = async () => { app.closeAllConnections(); if (app.listening) await new Promise(resolve => app.close(resolve)); };
  t.after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = async body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) });
  const sql = (query, ...params) => { const db = new DatabaseSync(join(dir, 'requests.sqlite'));
    try { return /^\s*SELECT/i.test(query) ? db.prepare(query).all(...params).map(r => ({ ...r })) : db.prepare(query).run(...params); } finally { db.close(); } };
  const addClient = row => sql(`INSERT INTO clients (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, ...Object.values(row));
  return { post, sent, sql, addClient, close, dir };
}
const result = async response => JSON.parse((await response.json()).results[0].result);
const alerts = sent => sent.filter(s => s.url.includes('resend') && s.headers['Idempotency-Key'].includes('-alert-'));
const capAlerts = sent => sent.filter(s => s.url.includes('resend') && s.headers['Idempotency-Key'].endsWith('-minute-cap'));

test('the clients table has the trial defaults', async t => {
  const { addClient, sql } = await fixture(t);
  addClient({ id: 'c1', business: 'Trial Plumbing', owner_name: 'Pat', owner_cell: '+16155550400', shop_number: '+16155550500', state: 'TN', created_at: '2026-10-15T00:00:00Z' });
  const [row] = sql('SELECT * FROM clients');
  assert.deepEqual([row.assistant_id, row.status, row.minute_cap, row.minutes_used, row.office_emails, row.alert_call, row.cap_alerted_at],
    [null, 'pending_verification', 300, 0, '[]', '[]', null]);
  // assistant_id is unique once set; unknown statuses are refused.
  addClient(client('c2'));
  assert.throws(() => addClient(client('c3', { assistant_id: 'asst-c2' })), /UNIQUE/);
  assert.throws(() => addClient(client('c4', { status: 'trial' })), /CHECK/);
});

test('an active trial client gets office emails and alert calls, never SMS', async t => {
  const { post, sent, addClient } = await fixture(t, { VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'from-line' });
  addClient(client('a', { transfer: '+16155550402' }));
  const saved = await result(await post(toolCall('call-a', 'asst-a', { ...intake, issue: 'URGENT - pipe burst', email_status: 'skipped_emergency' })));
  assert.equal(saved.saved, true); assert.equal(saved.office_alert, 'sent'); assert.equal(saved.live_transfer, 'available');
  assert.equal(sent.filter(s => s.url.includes('telnyx')).length, 0);
  assert.deepEqual(alerts(sent).map(s => [s.body.to, s.body.subject]), [[['desk@trial.example'], 'URGENT – pipe burst – 48 Birch Road – (615) 555-0142']]);
  // The spoken alert waits for the live transfer to the client's transfer number.
  const answer = await (await post({ message: { type: 'transfer-destination-request', call: call('call-a', 'asst-a') } })).json();
  assert.equal(answer.destination.number, '+16155550402');
  await post({ message: { type: 'tool-calls', call: call('call-a', 'asst-a'), toolCallList: [{ id: 't', function: { name: 'transfer_no_answer', arguments: {} } }] } });
  assert.deepEqual(sent.filter(s => s.url === 'https://api.vapi.ai/call').map(s => s.body.customer.number), ['+16155550401']);
});

test('a trial with no alert numbers rings the owner cell for urgent jobs, as the signup form promises', async t => {
  const { post, sent, addClient } = await fixture(t, { VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'from-line' });
  addClient(client('o', { alert_call: '[]' }));
  const saved = await result(await post(toolCall('call-o', 'asst-o', { ...intake, issue: 'URGENT - pipe burst', email_status: 'skipped_emergency' })));
  assert.equal(saved.saved, true);
  assert.deepEqual(sent.filter(s => s.url === 'https://api.vapi.ai/call').map(s => s.body.customer.number), ['+16155550400']);
  // A normal job still only emails.
  sent.length = 0;
  await post(toolCall('call-o2', 'asst-o', { ...intake, issue: 'Dripping faucet' }));
  assert.equal(sent.filter(s => s.url === 'https://api.vapi.ai/call').length, 0);
});

test('an ALERT_ROUTES entry wins over a client row with the same assistant', async t => {
  const { post, sent, addClient } = await fixture(t);
  addClient(client('dup', { assistant_id: 'gold-star' }));
  await post(toolCall('call-g', 'gold-star'));
  assert.deepEqual(alerts(sent).map(s => s.body.to), [['office@example.com']]);
  assert.equal(sent.filter(s => s.url.includes('telnyx')).length, 1);
});

test('a client that is not active has no route', async t => {
  const { post, sent, addClient } = await fixture(t);
  for (const status of ['pending_verification', 'provisioning', 'ended']) addClient(client(status, { status }));
  for (const status of ['pending_verification', 'provisioning', 'ended'])
    assert.equal((await result(await post(toolCall(`call-${status}`, `asst-${status}`)))).office_alert, 'not_configured');
  assert.equal((await result(await post(toolCall('call-none', 'asst-unknown')))).office_alert, 'not_configured');
  assert.equal(alerts(sent).length, 0);
});

test('call minutes accumulate once per call', async t => {
  const { post, sql, addClient } = await fixture(t);
  addClient(client('m'));
  assert.equal((await post(report('m-1', 'asst-m', 90))).status, 200);
  await post(report('m-1', 'asst-m', 90)); // Vapi resent the same report
  await post(report('m-2', 'asst-m', 30));
  await post({ message: { type: 'end-of-call-report', durationMinutes: 2.5, call: call('m-3', 'asst-m') } });
  await post(report('g-1', 'gold-star', 600)); // env clients are not metered here
  assert.deepEqual(sql('SELECT minutes_used FROM clients'), [{ minutes_used: 4.5 }]);
  assert.deepEqual(sql('SELECT call_id, minutes FROM client_calls ORDER BY call_id').map(r => [r.call_id, r.minutes]), [['m-1', 1.5], ['m-2', 0.5], ['m-3', 2.5]]);
});

test('crossing the minute cap emails Anchorline exactly once and calls keep being answered', async t => {
  const { post, sent, sql, addClient } = await fixture(t);
  addClient(client('cap', { minute_cap: 5, minutes_used: 3 }));
  await post(report('cap-1', 'asst-cap', 60));
  assert.equal(capAlerts(sent).length, 0);
  await post(report('cap-2', 'asst-cap', 90)); // 5.5 of 5
  await post(report('cap-2', 'asst-cap', 90));
  await post(report('cap-3', 'asst-cap', 120));
  const [notice, ...more] = capAlerts(sent);
  assert.equal(more.length, 0);
  assert.deepEqual(notice.body.to, ['jake@example.com']);
  assert.equal(notice.body.subject, 'Trial over minute cap: Trial cap Plumbing');
  assert.match(notice.body.text, /5\.5 of 5 trial minutes/);
  assert.equal(sql('SELECT minutes_used FROM clients')[0].minutes_used, 7.5);
  assert.ok(sql('SELECT cap_alerted_at FROM clients')[0].cap_alerted_at);
  assert.equal((await result(await post(toolCall('cap-4', 'asst-cap')))).saved, true);
});

test('rolling back to v1.5.0 with trial tables present still saves requests, and rolling forward keeps the clients', async t => {
  const first = await fixture(t);
  first.addClient(client('r'));
  await first.post(report('r-1', 'asst-r', 120));
  await first.close();
  const old = await fixture(t, {}, createV150, first.dir);
  assert.equal((await result(await old.post(toolCall('after-rollback', 'gold-star')))).saved, true);
  await old.close();
  const again = await fixture(t, {}, createApp, first.dir);
  assert.deepEqual(again.sql('SELECT id, minutes_used FROM clients'), [{ id: 'r', minutes_used: 2 }]);
});
