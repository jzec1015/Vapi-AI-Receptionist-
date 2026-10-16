import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from './server.mjs';

// A save the server sent back (read-back, house number, email checks), then the caller hung up: the end-of-call net
// saves what Emma had, with a flag saying what was not confirmed. Round 3's r-diy call lost its job this way.
const key = 'synthetic-test-key-not-used-in-production';
async function fixture(t, route) {
  const dir = mkdtempSync(join(tmpdir(), 'refused-test-'));
  const sent = [];
  const send = async (url, init) => { sent.push({ url, body: JSON.parse(init.body || '{}') }); return Response.json({ id: `id-${sent.length}` }, { status: 201 }); };
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ALERT_ROUTES: JSON.stringify({ 'shop-a': route }), VAPI_API_KEY: 'fixture-only',
    ALERT_CALL_FROM_ID: 'from-line', RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com' }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); await new Promise(r => app.close(r)); rmSync(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = async body => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) })).json();
  // No customer number: the simulation in round 3 had none, so the payload's callback number is all there is.
  const save = async (id, args, messages = []) => JSON.parse((await post({ message: { type: 'tool-calls', call: { id, assistantId: 'shop-a' },
    artifact: { messages }, toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } })).results[0].result);
  const hangUp = (id, extra = {}) => post({ message: { type: 'end-of-call-report', durationSeconds: 95, endedReason: 'customer-ended-call',
    call: { id, assistantId: 'shop-a', type: 'inboundPhoneCall' }, ...extra } });
  const officeEmails = () => sent.filter(s => s.url.includes('resend') && JSON.stringify(s.body.to).includes('office@example.com'));
  return { save, hangUp, officeEmails };
}
const route = { business: 'Riverbend Plumbing', email: ['office@example.com'], hours: { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 24 } };
const job = { name: 'Dana Whitfield', address: '501 Woodland Street, Nashville, TN 37206', issue: 'Kitchen faucet dripping', is_test: false,
  callback_phone: '6155550142', callback_read_back: false, email_status: 'declined' };

test('refused save, then the caller hangs up: the job is saved with what Emma had and a flag', async t => {
  const { save, hangUp, officeEmails } = await fixture(t, route);
  const refused = await save('diy', job);
  assert.equal(refused.saved, false);
  assert.match(refused.error, /read the callback number back first/);
  await hangUp('diy');
  assert.equal(officeEmails().length, 1);
  const text = officeEmails()[0].body.text;
  assert.match(text, /Dana Whitfield/);
  assert.match(text, /Kitchen faucet dripping/);
  assert.match(text, /Caller hung up before Emma finished: callback number not confirmed, check it/);
});

test('refused save, then a good save: one job, no second save at hang-up', async t => {
  const { save, hangUp, officeEmails } = await fixture(t, route);
  assert.equal((await save('ok', job)).saved, false);
  const second = await save('ok', { ...job, callback_read_back: true });
  assert.equal(second.saved, true);
  await hangUp('ok');
  assert.equal(officeEmails().length, 1);
  assert.doesNotMatch(officeEmails()[0].body.text, /Caller hung up before Emma finished/);
});

test('a refused test call saved at hang-up never alerts the client', async t => {
  const { save, hangUp, officeEmails } = await fixture(t, route);
  assert.equal((await save('test', { ...job, is_test: true })).saved, false);
  await hangUp('test');
  assert.equal(officeEmails().length, 0);
});

test('no save attempt and no caller ID: the caller\'s own words still reach the office', async t => {
  const { hangUp, officeEmails } = await fixture(t, route);
  await hangUp('words', { artifact: { messages: [{ role: 'user', message: 'Hi, my water heater is leaking from the bottom.' }, { role: 'bot', message: 'Oh no. What is your name?' }] } });
  assert.equal(officeEmails().length, 1);
  assert.match(officeEmails()[0].body.text, /Caller said: Hi, my water heater is leaking from the bottom\./);
});

test('existing customers and "Not a job" calls may save without an email; other non-urgent jobs may not', async t => {
  const { save } = await fixture(t, route);
  const noEmail = { ...job, callback_read_back: true, email_status: 'skipped_emergency' };
  const readBack = [{ role: 'bot', message: "So that's 6 1 5, 5 5 5, 0 1 4 2?" }, { role: 'user', message: 'Yes.' }];
  assert.equal((await save('late', { ...noEmail, issue: 'Tech has not shown up' },
    [{ role: 'user', message: "I had an appointment today and the tech hasn't shown up." }, ...readBack])).saved, true);
  assert.equal((await save('pitch', { ...noEmail, issue: 'Not a job - SEO company pitching services' }, readBack)).saved, true);
  const plain = await save('plain', noEmail, readBack);
  assert.equal(plain.saved, false);
  assert.match(plain.error, /ask the caller for their email first/);
});
