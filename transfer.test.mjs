import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp, transferDestination } from './server.mjs';

const key = 'synthetic-test-key-not-used-in-production';
const owner = '+15550000777';
const route = { business: 'Gold Star Plumbing', email: ['office@example.com'], sms: [], call: ['+15550000999'], transfer: owner };
const baseEnv = { VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'from-line', RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com' };
const intake = { name: 'Linda Harper', address: '48 Birch Road', issue: 'URGENT - water spraying under kitchen sink', is_test: false,
  callback_phone: '6155550142', callback_read_back: true, email_status: 'skipped_emergency' };
const call = (id, extra = {}) => ({ id, assistantId: 'client-a', customer: { number: '+16155550100' }, ...extra });
const toolCall = (id, name, args) => ({ message: { type: 'tool-calls', call: call(id), toolCallList: [{ id: 'tool-1', function: { name, arguments: args } }] } });
const destinationRequest = id => ({ message: { type: 'transfer-destination-request', call: call(id) } });
const endOfCall = (id, endedReason) => ({ message: { type: 'end-of-call-report', endedReason, durationSeconds: 90, call: call(id, { type: 'inboundPhoneCall' }) } });

// vapiCall: what GET https://api.vapi.ai/call/<id> answers (null = HTTP 404).
async function fixture(t, { routes = { 'client-a': route }, env = {}, vapiCall = null, dir = mkdtempSync(join(tmpdir(), 'transfer-test-')), keep = false } = {}) {
  const sent = [];
  const send = async (url, init) => {
    if (init.method === 'GET') { sent.push({ url, method: 'GET' }); return vapiCall ? Response.json(vapiCall) : new Response('{}', { status: 404 }); }
    sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 });
  };
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ALERT_ROUTES: JSON.stringify(routes), ...baseEnv, ...env }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { if (app.listening) await new Promise(resolve => app.close(resolve)); if (!keep) rmSync(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = async body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) });
  const alertCalls = () => sent.filter(s => s.url === 'https://api.vapi.ai/call');
  return { post, sent, alertCalls, app, dir };
}
const result = async response => JSON.parse((await response.json()).results[0].result);

test('an urgent job on a transfer line offers a live transfer and holds the alert call', async t => {
  const { post, sent, alertCalls } = await fixture(t);
  const saved = await result(await post(toolCall('u-1', 'submit_service_request', intake)));
  assert.equal(saved.saved, true); assert.equal(saved.live_transfer, 'available'); assert.equal(saved.office_alert, 'sent');
  assert.equal(sent.filter(s => s.url.includes('resend')).length, 1);
  assert.equal(alertCalls().length, 0);
  const routine = await result(await post(toolCall('r-1', 'submit_service_request', { ...intake, issue: 'Slow drain', email_status: 'declined' })));
  assert.equal(routine.live_transfer, undefined);
  const testCall = await result(await post(toolCall('t-1', 'submit_service_request', { ...intake, is_test: true })));
  assert.equal(testCall.live_transfer, undefined);
});

test('the transfer destination warms up the owner with the saved job and keeps Emma on a failed transfer', async t => {
  const { post } = await fixture(t);
  assert.match((await (await post(destinationRequest('d-1'))).json()).error, /save the request/);
  await post(toolCall('d-1', 'submit_service_request', intake));
  const { destination } = await (await post(destinationRequest('d-1'))).json();
  assert.equal(destination.type, 'number'); assert.equal(destination.number, owner);
  assert.equal(destination.callerId, '{{phoneNumber.number}}');
  const plan = destination.transferPlan;
  assert.equal(plan.mode, 'warm-transfer-experimental');
  assert.equal(plan.fallbackPlan.endCallEnabled, false);
  const prompt = plan.transferAssistant.model.messages[0].content;
  for (const part of ['urgent caller on hold: Linda Harper, at 48 Birch Road. water spraying under kitchen sink.', '(615) 555-0142', 'transferSuccessful', 'transferCancel', 'voicemail'])
    assert.ok(prompt.includes(part), part);
  assert.doesNotMatch(prompt, /URGENT -/);
  assert.match((await (await post(destinationRequest('d-1'))).json()).error, /already tried/);
});

test('a routine job, a line without a transfer number or a bad number is never transferred', async t => {
  const { post } = await fixture(t, { routes: { 'client-a': { ...route, transfer: '720-320-5877' } } });
  await post(toolCall('n-1', 'submit_service_request', intake));
  assert.match((await (await post(destinationRequest('n-1'))).json()).error, /only for urgent jobs/);
  const other = await fixture(t);
  await other.post(toolCall('n-2', 'submit_service_request', { ...intake, issue: 'Faucet drip', email_status: 'declined' }));
  assert.match((await (await other.post(destinationRequest('n-2'))).json()).error, /only for urgent jobs/);
});

test('no answer places the urgent alert call once, saying the transfer was missed', async t => {
  const { post, alertCalls } = await fixture(t);
  assert.equal((await result(await post(toolCall('x-1', 'transfer_no_answer', {})))).saved, false);
  await post(toolCall('x-1', 'submit_service_request', intake));
  await post(destinationRequest('x-1'));
  const alerted = await result(await post(toolCall('x-1', 'transfer_no_answer', {})));
  assert.equal(alerted.saved, true); assert.equal(alerted.owner_alert, 'sent');
  assert.equal(alertCalls().length, 1);
  assert.equal(alertCalls()[0].body.customer.number, '+15550000999');
  assert.match(alertCalls()[0].body.assistant.firstMessage, /Callback number: \(615\) 555-0142\. I tried to put them through to you live but couldn't reach you/);
  assert.equal((await result(await post(toolCall('x-1', 'transfer_no_answer', {})))).owner_alert, 'already_sent');
  await post(endOfCall('x-1', 'customer-ended-call'));
  assert.equal(alertCalls().length, 1);
});

test('a call handed to the owner never triggers the alert call', async t => {
  const { post, alertCalls, app } = await fixture(t, { env: { TRANSFER_FALLBACK_SECONDS: '0' } });
  await post(toolCall('c-1', 'submit_service_request', intake));
  await post(destinationRequest('c-1'));
  await post(endOfCall('c-1', 'assistant-forwarded-call'));
  assert.deepEqual(await app.sweepTransfers(Date.now() + 1000), []);
  assert.equal(alertCalls().length, 0);
});

test('a caller who hangs up during the transfer still gets the owner an alert call', async t => {
  const { post, alertCalls } = await fixture(t);
  await post(toolCall('h-1', 'submit_service_request', intake));
  await post(destinationRequest('h-1'));
  await post(endOfCall('h-1', 'customer-ended-call-during-transfer'));
  assert.equal(alertCalls().length, 1);
});

test('the backstop alerts when the outcome is unknown and skips a connected transfer', async t => {
  const silent = await fixture(t, { env: { TRANSFER_FALLBACK_SECONDS: '0' } });
  await silent.post(toolCall('b-1', 'submit_service_request', intake));
  assert.deepEqual(await silent.app.sweepTransfers(Date.now() + 1000), ['sent']);
  assert.equal(silent.alertCalls().length, 1);
  assert.deepEqual(await silent.app.sweepTransfers(Date.now() + 1000), []);
  const live = await fixture(t, { env: { TRANSFER_FALLBACK_SECONDS: '0' }, vapiCall: { id: 'b-2', status: 'forwarding' } });
  await live.post(toolCall('b-2', 'submit_service_request', intake));
  await live.post(destinationRequest('b-2'));
  assert.deepEqual(await live.app.sweepTransfers(Date.now() + 1000), ['connected']);
  assert.equal(live.alertCalls().length, 0);
  assert.equal(live.sent.filter(s => s.method === 'GET')[0].url, 'https://api.vapi.ai/call/b-2');
});

test('a held alert waits for its window and survives a restart', async t => {
  const first = await fixture(t, { env: { TRANSFER_FALLBACK_SECONDS: '60' }, keep: true });
  await first.post(toolCall('p-1', 'submit_service_request', intake));
  assert.deepEqual(await first.app.sweepTransfers(), []);
  first.app.closeAllConnections(); await new Promise(resolve => first.app.close(resolve));
  const second = await fixture(t, { env: { TRANSFER_FALLBACK_SECONDS: '60' }, dir: first.dir });
  assert.deepEqual(await second.app.sweepTransfers(Date.now() + 61000), ['sent']);
  assert.equal(second.alertCalls().length, 1);
});

test('transfer destination falls back to caller ID when no callback number was given', () => {
  const { transferPlan } = transferDestination(route, { ...intake, callback_phone: '', caller_id: '+16155550100' });
  assert.match(transferPlan.transferAssistant.model.messages[0].content, /They're calling from \(615\) 555-0100\. Can you take the call now\?/);
});

test('an urgent test call on a transfer line never rings, transfers to or alerts the owner', async t => {
  const { post, sent, app } = await fixture(t, { env: { TRANSFER_FALLBACK_SECONDS: '0', TEST_CALLER_NUMBERS: '+16155550100' } });
  // Said "this is a test call", and separately a live-looking urgent call from a listed test number.
  const said = await result(await post(toolCall('tt-1', 'submit_service_request', { ...intake, is_test: true })));
  const fromJake = await result(await post(toolCall('tt-2', 'submit_service_request', intake)));
  for (const saved of [said, fromJake]) { assert.equal(saved.saved, true); assert.equal(saved.office_alert, 'suppressed_test'); assert.equal(saved.live_transfer, undefined); }
  for (const id of ['tt-1', 'tt-2']) {
    assert.match((await (await post(destinationRequest(id))).json()).error, /only for urgent jobs/);
    assert.equal((await result(await post(toolCall(id, 'transfer_no_answer', {})))).saved, false);
    await post(endOfCall(id, 'customer-ended-call'));
  }
  assert.deepEqual(await app.sweepTransfers(Date.now() + 3600000), []);
  assert.deepEqual(sent, []);
});

// The callback rule (callbackNumbers): only a callback_phone saved with callback_read_back true is "the callback number";
// otherwise the owner hears "calling from <caller ID>"; with neither, there is no number and the email is the place to look.
test('the transfer intro, the alert call and the office texts name the callback number only when it was read back', async t => {
  const full = { ...route, sms: ['+15550000001'], email: ['office@example.com'] };
  const env = { TELNYX_API_KEY: 'fixture-only', TELNYX_FROM: '+15550000000', OFFICE_EMAIL: 'ops@example.com' };
  const { callback_read_back, ...unconfirmed } = intake;
  const cases = [
    { name: 'confirmed, differs from the caller ID', args: { callback_phone: '(615) 555-0199', callback_read_back: true }, from: '+16155550100',
      intro: 'Their callback number is (615) 555-0199. Can you take the call now?', alert: 'Callback number: (615) 555-0199. I tried',
      line: 'Linda Harper - (615) 555-0199 (confirmed on the call; caller ID (615) 555-0100)', subject: '– (615) 555-0199', receipt: 'Phone: (615) 555-0199 (confirmed on the call; caller ID (615) 555-0100)' },
    { name: 'confirmed, same as the caller ID', args: { callback_phone: '6155550100', callback_read_back: true }, from: '+16155550100',
      intro: 'Their callback number is (615) 555-0100.', alert: 'Callback number: (615) 555-0100.',
      line: 'Linda Harper - (615) 555-0100 (confirmed on the call)\n', subject: '– (615) 555-0100', receipt: 'Phone: (615) 555-0100 (confirmed on the call)\n' },
    { name: 'no callback_phone', args: { callback_phone: '', callback_read_back: false }, from: '+16155550100',
      intro: 'They\'re calling from (615) 555-0100. Can you take the call now?', alert: 'They were calling from (615) 555-0100. They didn\'t give a callback number.',
      line: 'Linda Harper - (615) 555-0100 (caller ID)\n', subject: '– (615) 555-0100 (caller ID)', receipt: 'Phone: (615) 555-0100 (caller ID)\n' },
    { name: 'callback_read_back false', args: { callback_phone: '6155550199', callback_read_back: false }, from: '+16155550100',
      intro: 'They\'re calling from (615) 555-0100. Can you take the call now?', alert: 'They were calling from (615) 555-0100. Their callback number wasn\'t confirmed, so check your email.',
      line: 'Linda Harper - (615) 555-0100 (caller ID; gave (615) 555-0199, not confirmed)', subject: '– (615) 555-0100 (caller ID)', receipt: 'Phone: (615) 555-0100 (caller ID; gave (615) 555-0199, not confirmed)' },
    { name: 'callback_read_back missing', args: { callback_phone: '6155550199' }, from: '+16155550100',
      intro: 'They\'re calling from (615) 555-0100.', alert: 'They were calling from (615) 555-0100. Their callback number wasn\'t confirmed',
      line: '(caller ID; gave (615) 555-0199, not confirmed)', subject: '– (615) 555-0100 (caller ID)', receipt: 'Phone: (615) 555-0100 (caller ID; gave' },
    { name: 'read back, but not a 10-digit number', args: { callback_phone: '555-0199 ext 4', callback_read_back: true }, from: '+16155550100',
      intro: 'They\'re calling from (615) 555-0100.', alert: 'They were calling from (615) 555-0100. Their callback number wasn\'t confirmed',
      line: '(615) 555-0100 (caller ID; gave 555-0199 ext 4, not confirmed)', subject: '– (615) 555-0100 (caller ID)', receipt: 'Phone: (615) 555-0100 (caller ID; gave 555-0199 ext 4, not confirmed)' },
    { name: 'blocked caller ID, nothing given', args: { callback_phone: '', callback_read_back: false }, from: '+266696687',
      intro: 'There\'s no number for them and no caller ID, so check your email after the call. Can you take the call now?',
      alert: 'There\'s no number for them and no caller ID, so check your email. I tried', line: 'Linda Harper - no number given (no caller ID)\n',
      subject: '– no number given', receipt: 'Phone: no number given (no caller ID)\n' },
    { name: 'no caller ID at all, number not read back', args: { callback_phone: '6155550199', callback_read_back: false }, from: undefined,
      intro: 'There\'s no confirmed callback number and no caller ID, so check your email after the call.',
      alert: 'There\'s no confirmed callback number and no caller ID, so check your email.', line: 'Linda Harper - (615) 555-0199 (not confirmed; no caller ID)\n',
      subject: '– (615) 555-0199 (not confirmed)', receipt: 'Phone: (615) 555-0199 (not confirmed; no caller ID)\n' },
    { name: 'anonymous caller ID, confirmed number', args: { callback_phone: '6155550199', callback_read_back: true }, from: 'anonymous',
      intro: 'Their callback number is (615) 555-0199.', alert: 'Callback number: (615) 555-0199.', line: 'Linda Harper - (615) 555-0199 (confirmed on the call)\n',
      subject: '– (615) 555-0199', receipt: 'Phone: (615) 555-0199 (confirmed on the call)\n' }
  ];
  for (const [i, c] of cases.entries()) {
    const { post, sent, alertCalls } = await fixture(t, { routes: { 'client-a': full }, env });
    const id = `cb-${i}`;
    const customer = c.from === undefined ? {} : { number: c.from };
    const msg = (type, extra) => ({ message: { type, call: call(id, { customer }), ...extra } });
    await post(msg('tool-calls', { toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: { ...unconfirmed, ...c.args } } }] }));
    const { destination } = await (await post(msg('transfer-destination-request'))).json();
    const prompt = destination.transferPlan.transferAssistant.model.messages[0].content;
    assert.ok(prompt.includes(c.intro), `${c.name}: intro\n${prompt}`);
    await post(msg('tool-calls', { toolCallList: [{ id: 'tool-2', function: { name: 'transfer_no_answer', arguments: {} } }] }));
    const spoken = alertCalls()[0].body.assistant;
    assert.ok(spoken.firstMessage.includes(c.alert), `${c.name}: alert call\n${spoken.firstMessage}`);
    assert.ok(spoken.model.messages[0].content.includes(c.alert.replace(/ I tried$/, '')), `${c.name}: alert call prompt`);
    if (!c.args.callback_read_back || !c.alert.startsWith('Callback number')) {
      // Never "callback number: <caller ID>" / "their callback number is <caller ID>" when nothing was read back.
      for (const text of [prompt, spoken.firstMessage]) assert.doesNotMatch(text, /[Cc]allback number(:| is) \(/, c.name);
    }
    const sms = sent.filter(s => s.url.includes('telnyx'));
    assert.equal(sms.length, 1); assert.ok(sms[0].body.text.includes(c.line), `${c.name}: sms\n${sms[0].body.text}`);
    const card = sent.find(s => s.url.includes('resend') && s.body.to?.[0] === 'office@example.com');
    assert.ok(card.body.text.includes(c.line), `${c.name}: email card`); assert.ok(card.body.subject.endsWith(c.subject.replace(/\n$/, '')), `${c.name}: subject ${card.body.subject}`);
    const receipt = sent.find(s => s.url.includes('resend') && s.body.subject === 'Anchorline service request received');
    assert.ok(receipt.body.text.includes(c.receipt), `${c.name}: office receipt\n${receipt.body.text}`);
  }
});
