import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp, callerWordsAfterSave } from './server.mjs';

// Round 6: answers given AFTER the save (own/rent, landlord, a preferred day) never reached the job because Emma did not
// call add_request_note. The end-of-call report now adds them as a note, re-tags them, and sends one update only when
// it matters. Also: a hang-up whose caller said only "Goodbye" is stored, not alerted.
const key = 'synthetic-test-key-not-used-in-production';
async function fixture(t, route) {
  const dir = mkdtempSync(join(tmpdir(), 'postsave-test-'));
  const sent = [];
  const send = async (url, init) => { sent.push({ url, body: JSON.parse(init.body || '{}') }); return Response.json({ id: `id-${sent.length}` }, { status: 201 }); };
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ALERT_ROUTES: JSON.stringify({ 'shop-a': route }), VAPI_API_KEY: 'fixture-only',
    ALERT_CALL_FROM_ID: 'from-line', RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com' }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); await new Promise(r => app.close(r)); rmSync(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = async body => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) })).json();
  const save = async (id, args, messages = []) => JSON.parse((await post({ message: { type: 'tool-calls', call: { id, assistantId: 'shop-a' },
    artifact: { messages }, toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } })).results[0].result);
  const end = (id, messages, extra = {}) => post({ message: { type: 'end-of-call-report', durationSeconds: 120, endedReason: 'customer-ended-call',
    call: { id, assistantId: 'shop-a', type: 'inboundPhoneCall' }, artifact: { messages }, ...extra } });
  const officeEmails = () => sent.filter(s => s.url.includes('resend') && JSON.stringify(s.body.to).includes('office@example.com'));
  return { save, end, officeEmails };
}
const route = { business: 'Riverbend Plumbing', email: ['office@example.com'], hours: { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 24 } };
const job = { name: 'Dana Whitfield', address: '501 Woodland Street, Nashville, TN 37206', issue: 'Kitchen faucet dripping', is_test: false,
  callback_phone: '6155550142', callback_read_back: true, email_status: 'ask_after_save' };
const readBack = [{ role: 'bot', message: "So that's 6 1 5, 5 5 5, 0 1 4 2?" }, { role: 'user', message: 'Yes.' }];
const saveTurns = [{ role: 'tool_calls', toolCalls: [{ function: { name: 'submit_service_request' } }] },
  { role: 'tool_call_result', name: 'submit_service_request', result: '{"saved":true}' }];

test('callerWordsAfterSave keeps only what the caller said after the save', () => {
  const words = callerWordsAfterSave([{ role: 'user', message: 'My faucet drips.' }, ...saveTurns,
    { role: 'bot', message: 'Do you own or rent?' }, { role: 'user', message: 'We rent.' }], '2026-10-17T00:00:00Z');
  assert.equal(words, 'We rent.');
  assert.equal(callerWordsAfterSave(null, ''), '');
});

test('landlord and a preferred day said after the save reach the job, with one update alert', async t => {
  const { save, end, officeEmails } = await fixture(t, route);
  assert.equal((await save('rent', job, readBack)).saved, true);
  assert.equal(officeEmails().length, 1);
  await end('rent', [...readBack, ...saveTurns, { role: 'bot', message: 'Do you own the home, or rent?' },
    { role: 'user', message: 'We rent. The landlord is Bob Jones, 615 555 0199.' }, { role: 'bot', message: 'What day works best?' },
    { role: 'user', message: 'Tuesday morning is good.' }]);
  assert.equal(officeEmails().length, 2);
  const update = officeEmails()[1].body.text;
  assert.match(update, /After save, caller said: We rent\. The landlord is Bob Jones, 615 555 0199\. Tuesday morning is good\./);
});

test('nothing new after the save: stored, no second alert', async t => {
  const { save, end, officeEmails } = await fixture(t, route);
  assert.equal((await save('bye', job, readBack)).saved, true);
  await end('bye', [...readBack, ...saveTurns, { role: 'user', message: 'Okay, thank you so much. Bye.' }]);
  assert.equal(officeEmails().length, 1);
});

test('a time already noted by Emma does not alert again', async t => {
  const { save, end, officeEmails } = await fixture(t, route);
  assert.equal((await save('noted', { ...job, preferred_time: 'Tuesday morning' }, readBack)).saved, true);
  await end('noted', [...readBack, ...saveTurns, { role: 'user', message: 'Tuesday morning, like I said.' }]);
  assert.equal(officeEmails().length, 1);
});

test('an emergency said after the save makes the job URGENT and alerts', async t => {
  const { save, end, officeEmails } = await fixture(t, route);
  assert.equal((await save('worse', job, readBack)).saved, true);
  await end('worse', [...readBack, ...saveTurns, { role: 'user', message: 'Oh no, now water is pouring everywhere under the sink.' }]);
  assert.equal(officeEmails().length, 2);
  assert.match(officeEmails()[1].body.subject || officeEmails()[1].body.text, /URGENT/);
});

test('a test call never alerts on post-save words', async t => {
  const { save, end, officeEmails } = await fixture(t, route);
  assert.equal((await save('t', { ...job, is_test: true }, readBack)).saved, true);
  await end('t', [...readBack, ...saveTurns, { role: 'user', message: 'We rent, landlord is Bob, Tuesday works.' }]);
  assert.equal(officeEmails().length, 0);
});

test('a hang-up where the caller only said goodbye is stored but not alerted; real words still alert', async t => {
  const { end, officeEmails } = await fixture(t, route);
  await end('gb', [{ role: 'bot', message: 'Thanks for calling Riverbend Plumbing.' }, { role: 'user', message: 'Goodbye.' }],
    { customer: { number: '+16155550111' }, call: { id: 'gb', assistantId: 'shop-a', type: 'inboundPhoneCall', customer: { number: '+16155550111' } } });
  assert.equal(officeEmails().length, 0);
  await end('real', [{ role: 'user', message: 'My toilet is clogged and' }],
    { call: { id: 'real', assistantId: 'shop-a', type: 'inboundPhoneCall', customer: { number: '+16155550112' } } });
  assert.equal(officeEmails().length, 1);
});

test('the save lists every follow-up for an ordinary job, and skips ones already answered', async t => {
  const { save } = await fixture(t, route);
  const all = await save('all', job, readBack);
  assert.match(all.next, /own the home, or rent/);
  assert.match(all.next, /landlord or property manager's name and number/);
  assert.match(all.next, /ask for their email/i);
  assert.match(all.next, /day or time works best/);
  const some = await save('some', { ...job, preferred_time: 'Friday afternoon', email_status: 'declined' },
    [...readBack, { role: 'user', message: 'We rent from a property management company.' }]);
  assert.ok(!some.next || !/own the home|email|day or time/i.test(some.next));
});
