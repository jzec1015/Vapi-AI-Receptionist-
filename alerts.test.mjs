import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp, alertText, phoneNumbersIn, confirmedCallback, transcriptExcerpt, priorityTier } from './server.mjs';

const key = 'synthetic-test-key-not-used-in-production';
const routes = JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'] } });
const alertEnv = { ALERT_ROUTES: routes, TELNYX_API_KEY: 'fixture-only', TELNYX_FROM: '+15550000000', RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com' };
const intake = { name: 'Linda Harper', address: '48 Birch Road', issue: 'URGENT - water under kitchen sink', is_test: false, callback_phone: '6155550142' };
const toolCall = (id, name, args, call = {}) => ({ message: { type: 'tool-calls', call: { id, assistantId: 'client-a', customer: { number: '+16155550100' }, ...call },
  toolCallList: [{ id: 'tool-1', function: { name, arguments: args } }] } });
async function fixture(t, extra = {}) {
  const sent = [];
  const send = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  const dir = mkdtempSync(join(tmpdir(), 'alerts-test-'));
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ...alertEnv, ...extra }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = async body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) });
  return { post, sent };
}
const result = async response => JSON.parse((await response.json()).results[0].result);

test('a saved request texts and emails only that client route', async t => {
  const { post, sent } = await fixture(t);
  const saved = await result(await post(toolCall('call-1', 'submit_service_request', intake)));
  assert.equal(saved.saved, true); assert.equal(saved.office_alert, 'sent');
  const sms = sent.filter(s => s.url.includes('telnyx'));
  assert.equal(sms.length, 1); assert.equal(sms[0].body.to, '+15550000001');
  assert.match(sms[0].body.text, /^Anchorline AI: URGENT call - Gold Star Plumbing/);
  assert.match(sms[0].body.text, /\(615\) 555-0142/);
  assert.equal(sent.filter(s => s.url.includes('resend')).length, 1);
  const other = await result(await post(toolCall('call-2', 'submit_service_request', intake, { assistantId: 'demo-line' })));
  assert.equal(other.office_alert, 'not_configured'); assert.equal(sent.length, 2);
});

test('test calls never alert a client unless the route opts in', async t => {
  const { post, sent } = await fixture(t);
  const saved = await result(await post(toolCall('call-t', 'submit_service_request', { ...intake, is_test: true })));
  assert.equal(saved.office_alert, 'suppressed_test'); assert.equal(sent.length, 0);
});

test('caller ID backs up a missing callback number', async t => {
  const { post, sent } = await fixture(t);
  await post(toolCall('call-3', 'submit_service_request', { ...intake, callback_phone: '' }));
  assert.match(sent[0].body.text, /\(615\) 555-0100 \(caller ID\)/);
});

test('notes append to the saved request and send an update', async t => {
  const { post, sent } = await fixture(t);
  assert.equal((await result(await post(toolCall('call-4', 'add_request_note', { note: 'Asked if you work Saturdays' })))).saved, false);
  await post(toolCall('call-4', 'submit_service_request', intake));
  const noted = await result(await post(toolCall('call-4', 'add_request_note', { note: 'Asked if you work Saturdays' })));
  assert.equal(noted.note_added, true); assert.equal(noted.office_alert, 'sent');
  assert.match(sent.filter(s => s.url.includes('telnyx')).at(-1).body.text, /^Anchorline AI: URGENT update - Gold Star Plumbing[\s\S]*Note: Asked if you work Saturdays/);
});

test('a hang-up before saving still reaches the office once', async t => {
  const { post, sent } = await fixture(t);
  const report = (id, durationSeconds) => ({ message: { type: 'end-of-call-report', durationSeconds, analysis: { summary: 'Caller reported a leak and hung up.' },
    call: { id, assistantId: 'client-a', type: 'inboundPhoneCall', customer: { number: '+16155550100' } } } });
  assert.equal((await post(report('hang-1', 45))).status, 200);
  await post(report('hang-1', 45));
  const sms = sent.filter(s => s.url.includes('telnyx'));
  assert.equal(sms.length, 1); assert.match(sms[0].body.text, /^Anchorline AI: Caller hung up - Gold Star Plumbing[\s\S]*\(615\) 555-0100 \(caller ID\)[\s\S]*leak/);
  await post(report('hang-short', 4));
  await post(toolCall('saved-call', 'submit_service_request', intake));
  const before = sent.length;
  await post(report('saved-call', 60));
  assert.equal(sent.length, before);
});

const hangupReport = (id, artifact, extra = {}) => ({ message: { type: 'end-of-call-report', durationSeconds: 95, artifact, ...extra,
  call: { id, assistantId: 'client-a', type: 'inboundPhoneCall', customer: { number: '+16155550100' } } } });
// The real shape: Vapi's artifact.messages (role bot/user, text in message) plus artifact.transcript.
const said = (...turns) => ({ messages: [{ role: 'system', message: 'You are Emma' }, ...turns.map(([role, message], i) => ({ role, message, secondsFromStart: i * 5 }))],
  transcript: turns.map(([role, text]) => `${role === 'bot' ? 'AI' : 'User'}: ${text}`).join('\n') });

test('a hang-up after a failed save keeps the read-back number the caller confirmed and the transcript', async t => {
  const { post, sent } = await fixture(t);
  const artifact = said(['bot', 'Hi, thanks for calling Gold Star Plumbing. How can I help?'], ['user', 'My water heater is leaking all over the garage.'],
    ['bot', "What's the best number to call you back?"], ['user', '615 555 0142.'],
    ['bot', 'So that\u2019s six one five, five five five, oh one four two?'], ['user', "Yeah, that's it."],
    ['tool_calls', ''], ['tool_call_result', 'retryable'],
    ['bot', 'Sorry, our system is down. The team will call you back at six one five, five five five, oh one four two.'], ['user', 'Okay, thanks.']);
  await post(hangupReport('hang-readback', artifact));
  const email = sent.find(s => s.url.includes('resend')).body;
  assert.equal(email.subject, 'Caller hung up \u2013 (615) 555-0142 \u2013 call them back');
  assert.match(email.text, /Unknown caller - \(615\) 555-0142 \(confirmed on the call; caller ID \(615\) 555-0100\)\n/);
  assert.match(email.text, /Hung up before finishing\nTranscript \(end of call\):\nAI: Hi, thanks[\s\S]*User: My water heater is leaking all over the garage\./);
  assert.match(sent.find(s => s.url.includes('telnyx')).body.text, /^Anchorline AI: Caller hung up - Gold Star Plumbing\nUnknown caller - \(615\) 555-0142 /);
});

test('a hang-up with a summary keeps it and adds the transcript; numerals count as a read-back', async t => {
  const { post, sent } = await fixture(t);
  await post(hangupReport('hang-numerals', { transcript: 'AI: Is 615-555-0177 the best number?\nUser: Correct.\nAI: And the address?' },
    { analysis: { summary: 'Caller reported a leak.' } }));
  const email = sent.find(s => s.url.includes('resend')).body;
  assert.equal(email.subject, 'Caller hung up \u2013 (615) 555-0177 \u2013 call them back');
  assert.match(email.text, /Hung up before finishing\. Summary: Caller reported a leak\.\nTranscript \(end of call\):\nAI: Is 615-555-0177/);
});

test('an unconfirmed read-back is never used; a corrected and confirmed one is', async t => {
  const { post, sent } = await fixture(t);
  await post(hangupReport('hang-no', said(['bot', 'So that is 6 1 5, 5 5 5, 0 1 4 2?'], ['user', "No, it's 615 555 0199."], ['bot', 'Got it, and your address?'])));
  const first = sent.find(s => s.url.includes('resend')).body;
  assert.equal(first.subject, 'Caller hung up \u2013 (615) 555-0100 \u2013 call them back');
  assert.match(first.text, /\(615\) 555-0100 \(caller ID\)/);
  await post(hangupReport('hang-fixed', said(['bot', 'So that is 6 1 5, 5 5 5, 0 1 4 2?'], ['user', "No, it's 615 555 0199."],
    ['bot', 'Sorry about that. Six one five, five five five, zero one nine nine?'], ['user', "Yes, that's right."])));
  assert.equal(sent.filter(s => s.url.includes('resend')).at(-1).body.subject, 'Caller hung up \u2013 (615) 555-0199 \u2013 call them back');
});

test('a hang-up report without a transcript is the same lead as before', async t => {
  const { post, sent } = await fixture(t);
  await post(hangupReport('hang-bare', undefined));
  const email = sent.find(s => s.url.includes('resend')).body;
  assert.equal(email.subject, 'Caller hung up \u2013 (615) 555-0100 \u2013 call them back');
  assert.match(email.text, /\(615\) 555-0100 \(caller ID\)\nHung up before giving details\n\nRequest reference: /);
});

test('a confirmed read-back on a test caller number keeps the hang-up suppressed', async t => {
  const { post, sent } = await fixture(t, { TEST_CALLER_NUMBERS: '+16155550142' });
  await post(hangupReport('hang-testnum', said(['bot', 'That is 615 555 0142, right?'], ['user', 'Yep.'])));
  assert.equal(sent.length, 0);
});

test('read-back parsing: spoken and written numbers, confirmations, excerpt length', () => {
  assert.deepEqual(phoneNumbersIn('six one five, five five five, oh one four two'), ['6155550142']);
  assert.deepEqual(phoneNumbersIn('Oh, so that is (615) 555-0142? And 1-615-555-0199.'), ['6155550142', '6155550199']);
  assert.deepEqual(phoneNumbersIn('5 0 1 Woodland Street. What is the best number?'), []);
  assert.deepEqual(phoneNumbersIn('six one five five five five oh one four'), []);
  assert.deepEqual(phoneNumbersIn('2 4 0 6 1 5 5 5 5 0 1 4 2'), []);
  const msg = turns => ({ artifact: said(...turns) });
  assert.equal(confirmedCallback(msg([['bot', 'Is it 615 555 0142?'], ['user', 'Right.']])), '6155550142');
  assert.equal(confirmedCallback(msg([['bot', 'Is it 615 555 0142?'], ['user', 'Uh, yes.']])), '6155550142');
  assert.equal(confirmedCallback(msg([['bot', 'Is it 615 555 0142?'], ['user', 'Not quite, it ends in 43.']])), '');
  assert.equal(confirmedCallback(msg([['bot', '5 0 1 Woodland Street, right? And your number?'], ['user', "Yes, that's right. It's 615 555 1992."]])), '');
  assert.equal(confirmedCallback(msg([['bot', 'Is it 615 555 0142?']])), '');
  assert.equal(confirmedCallback({}), '');
  assert.equal(confirmedCallback({ artifact: { messages: [{ role: 'assistant', content: 'So 615 555 0142?' }, { role: 'user', content: 'Yes.' }] } }), '6155550142');
  // Never mark a number confirmed unless the caller's next turn is a plain yes to Emma's read-back question.
  const N = '6155550142', ask = ['bot', 'Is it six one five, five five five, oh one four two?'];
  for (const reply of ['Yes, but it ends in 43.', 'Yeah no, that is my old number.', 'Yes... wait.', 'Yes?', 'Right, but the last digit is 3.',
    "Correct me if I'm wrong but I said 0143."]) assert.equal(confirmedCallback(msg([ask, ['user', reply]])), '', reply);
  assert.equal(confirmedCallback(msg([ask, ['user', 'Mhm.']])), N);
  assert.equal(confirmedCallback(msg([['bot', 'Okay, 615 555 0142. Is that right?'], ['user', "Yep, that's it."]])), N);
  assert.equal(confirmedCallback(msg([['bot', 'I have 615 555 0142. Is this urgent?'], ['user', 'Yeah, water everywhere']])), '');
  assert.equal(confirmedCallback(msg([['bot', 'Got it, 615 555 0142.'], ['bot', 'Is this an emergency?'], ['user', 'Yes!']])), '');
  assert.equal(confirmedCallback(msg([['bot', 'You can also reach the office at 615 555 0100.'], ['user', 'Right, okay.']])), '');
  assert.equal(confirmedCallback(msg([ask, ['user', 'Yes.'], ['bot', 'So 615 555 0143?']])), '', 'a later unconfirmed read-back clears it');
  assert.equal(confirmedCallback(msg([ask, ['user', 'Yes.'], ['bot', 'And the address?'], ['user', 'Oh, actually that number ends in 43.']])), '');
  assert.equal(confirmedCallback(msg([ask, ['user', 'Yes.'], ['bot', 'So 615 555 0199?'], ['user', 'Yes.']])), '6155550199');
  const turn = { artifact: { transcript: `AI: Hi.\nUser: ${'blah '.repeat(400)}the end` } };
  assert.match(transcriptExcerpt(turn), /^\u2026User: \u2026blah/); assert.ok(transcriptExcerpt(turn).length <= 1500);
  const long = { artifact: { transcript: Array.from({ length: 80 }, (_, i) => `${i % 2 ? 'User' : 'AI'}: line ${i} of the call`).join('\n') } };
  const excerpt = transcriptExcerpt(long);
  assert.ok(excerpt.length <= 1500); assert.match(excerpt, /^\u2026(AI|User): line \d+/); assert.match(excerpt, /User: line 79 of the call$/);
  assert.equal(transcriptExcerpt({}), '');
});

test('alert emails never carry the SMS opt-out line and are not cut short', async t => {
  const { post, sent } = await fixture(t);
  await post({ message: { type: 'end-of-call-report', durationSeconds: 45, analysis: { summary: 'Caller reported a leak and hung up.' },
    call: { id: 'hang-mail', assistantId: 'client-a', type: 'inboundPhoneCall', customer: { number: '+16155550100' } } } });
  const long = 'Water heater pilot keeps going out after about ten minutes. '.repeat(8).trim();
  await post(toolCall('mail-new', 'submit_service_request', { ...intake, name: 'José Núñez', issue: long, job_details: 'Rheem 40-gal' }));
  await post(toolCall('mail-new', 'add_request_note', { note: 'Gate code 4471' }));
  const emails = sent.filter(s => s.url.includes('resend'));
  assert.equal(emails.length, 3);
  for (const e of emails) { assert.doesNotMatch(e.body.text, /STOP/); assert.doesNotMatch(e.body.subject, /STOP/); }
  assert.equal(emails[0].body.subject, 'Caller hung up – (615) 555-0100 – call them back');
  assert.match(emails[0].body.text, /\(615\) 555-0100 \(caller ID\)\nHung up before finishing\. Summary: Caller reported a leak and hung up\.\n\nRequest reference: /);
  assert.ok(emails[1].body.text.includes(long)); assert.match(emails[1].body.text, /José Núñez[\s\S]*Details: Rheem 40-gal/);
  assert.match(emails[2].body.text, /Note: Gate code 4471/);
  for (const s of sent.filter(s => s.url.includes('telnyx'))) assert.match(s.body.text, /\nReply STOP to opt out$/);
});

test('alert text stays short and marks urgency', () => {
  const text = alertText({ business: 'Maple Plumbing' }, { ...intake, issue: 'Slow drain '.repeat(60), notes: [] });
  assert.ok(text.length <= 302); assert.match(text, /Reply STOP to opt out$/); assert.match(text, /^Anchorline AI: New call - Maple Plumbing/); assert.match(text, /^[\n\x20-\x7E]+$/);
});

test('a confirmed caller email gets a branded confirmation without promising a time', async t => {
  const { post, sent } = await fixture(t);
  const saved = await result(await post(toolCall('call-mail', 'submit_service_request',
    { ...intake, email: 'linda@example.com', email_confirmed: true, preferred_time: 'Thursday morning' })));
  assert.equal(saved.caller_email, 'accepted');
  const mail = sent.find(s => s.url.includes('resend') && s.body.to[0] === 'linda@example.com').body;
  assert.equal(mail.from, 'Gold Star Plumbing <alerts@example.com>');
  assert.equal(mail.subject, 'Gold Star Plumbing: we received your request');
  assert.deepEqual(mail.reply_to, ['office@example.com']);
  for (const part of ['Hi Linda Harper', 'Phone: (615) 555-0142', 'Service address: 48 Birch Road', 'Issue: water under kitchen sink',
    'Requested time: Thursday morning (the team will call to confirm)']) assert.ok(mail.text.includes(part), part);
  assert.doesNotMatch(mail.text, /URGENT/);
});

test('an unconfirmed email is never sent and no time defaults to a callback', async t => {
  const { post, sent } = await fixture(t);
  await post(toolCall('call-nomail', 'submit_service_request', { ...intake, email: 'x@example.com', email_confirmed: false }));
  assert.equal(sent.filter(s => s.url.includes('resend') && s.body.to[0] === 'x@example.com').length, 0);
});

test('a hang-up on a test call is recorded but never alerts the client', async t => {
  const { post, sent } = await fixture(t);
  await post({ message: { type: 'end-of-call-report', durationSeconds: 30, artifact: { transcript: 'User: Hi, this is a test call. My water heater is leaking.' },
    call: { id: 'hang-test', assistantId: 'client-a', type: 'inboundPhoneCall', customer: { number: '+16155550100' } } } });
  assert.equal(sent.length, 0);
});

test('urgent jobs phone the route owner; routine jobs and tests do not', async t => {
  const { post, sent } = await fixture(t, { VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'from-line',
    ALERT_ROUTES: JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', email: [], sms: [], call: ['+16155550999'] } }) });
  await post(toolCall('urgent-1', 'submit_service_request', intake));
  const calls = sent.filter(s => s.url === 'https://api.vapi.ai/call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.customer.number, '+16155550999');
  assert.equal(calls[0].body.phoneNumberId, 'from-line');
  assert.match(calls[0].body.assistant.firstMessage, /urgent job alert for Gold Star Plumbing\. Linda Harper, at 48 Birch Road\. water under kitchen sink\. Callback number: \(615\) 555-0142\./);
  await post(toolCall('routine-1', 'submit_service_request', { ...intake, issue: 'Slow drain' }));
  await post(toolCall('test-1', 'submit_service_request', { ...intake, is_test: true }));
  assert.equal(sent.filter(s => s.url === 'https://api.vapi.ai/call').length, 1);
});

test('job type, size and details reach the office alert', async t => {
  const { post, sent } = await fixture(t);
  await post(toolCall('call-job', 'submit_service_request', { ...intake, issue: 'Water heater quote',
    job_type: 'Replacement', job_size: 'Big job (half day+)', job_details: '50-gal gas tank, about 12 years old, leaking at base' }));
  const text = sent.find(s => s.url.includes('telnyx')).body.text;
  assert.match(text, /Job: Replacement - Big job \(half day\+\)/);
  assert.match(text, /Details: 50-gal gas tank, about 12 years old, leaking at base/);
  assert.match(text, /Reply STOP to opt out$/);
});

test('skipping the email question is refused for a non-urgent job', async t => {
  const { post } = await fixture(t);
  const r = await result(await post(toolCall('skip-1', 'submit_service_request', { ...intake, issue: 'Faucet drip', email_status: 'skipped_emergency' })));
  assert.equal(r.saved, false); assert.match(r.error, /ask the caller for their email/);
  const ok = await result(await post(toolCall('skip-2', 'submit_service_request', { ...intake, email_status: 'skipped_emergency' })));
  assert.equal(ok.saved, true);
});

test('a late email is only added after spell-back and then sends the confirmation', async t => {
  const { post, sent } = await fixture(t);
  await post(toolCall('late-1', 'submit_service_request', intake));
  const refused = await result(await post(toolCall('late-1', 'add_customer_email', { email: 'linda@example.com', confirmed_after_spelling_back: false })));
  assert.equal(refused.saved, false);
  const added = await result(await post(toolCall('late-1', 'add_customer_email', { email: 'linda@example.com', confirmed_after_spelling_back: true })));
  assert.equal(added.email_added, true); assert.equal(added.caller_email, 'accepted');
  assert.ok(sent.some(s => s.url.includes('resend') && s.body.to[0] === 'linda@example.com' && /we received your request/.test(s.body.subject)));
});

test('priority tiers: urgent, high-value (big job or big-ticket work), routine', () => {
  const cases = [
    [{ issue: 'URGENT - burst pipe', job_size: 'Big job (half day+)', job_type: 'Repipe' }, 'urgent', 'urgent beats a big job'],
    [{ issue: 'urgent - no water', job_size: 'Unknown' }, 'urgent', 'any case'],
    [{ issue: 'No hot water', job_type: 'Water heater replacement' }, 'high-value', 'water heater replacement'],
    [{ issue: 'Wants to replace the old 50-gallon water heater' }, 'high-value', 'replace ... water heater'],
    [{ issue: 'Quote for a new gas water heater' }, 'high-value', 'new water heater'],
    [{ issue: 'Interested in going tankless' }, 'high-value', 'tankless'],
    [{ issue: 'The water heater needs to be replaced' }, 'high-value', 'needs to be replaced'],
    [{ issue: 'Water heater leaking, wants a replacement quote' }, 'high-value', 'replacement quote in the same sentence'],
    [{ issue: 'Water heater is shot, wants a new one installed' }, 'high-value', 'new one / installed'],
    [{ issue: 'Water heater is not heating, wants a replacement quote' }, 'high-value', 'a negated symptom does not block the request'],
    [{ issue: 'No hot water', job_type: 'Water heater repair', job_details: 'Pilot light keeps going out' }, 'routine', 'water heater repair is not high-value'],
    [{ issue: 'Water heater repair' }, 'routine', 'water heater repair alone'],
    [{ issue: 'Replaced the water heater last year, now a drip under the sink' }, 'routine', 'past replacement, different problem'],
    [{ issue: 'Water heater was replaced in May, pilot light keeps going out' }, 'routine', 'was replaced'],
    [{ issue: 'Water heater is fine. Replace the kitchen faucet' }, 'routine', 'replace in another sentence'],
    [{ issue: 'Pilot light out' }, 'routine', 'pilot light alone'],
    [{ issue: 'Old galvanized pipes', job_type: 'Whole-house repipe' }, 'high-value', 'repipe'],
    [{ issue: 'Needs repiping', job_size: 'Unknown' }, 'high-value', 'repiping'],
    [{ issue: 'Slow drains everywhere', job_details: 'Main line backed up with roots' }, 'high-value', 'main line backup'],
    [{ issue: 'Sewer line collapsed in the yard' }, 'high-value', 'sewer line'],
    [{ issue: 'Warm spot on the floor', job_type: 'Slab leak' }, 'high-value', 'slab leak'],
    [{ issue: 'Bathroom remodel rough-in' }, 'high-value', 'remodel'],
    [{ issue: 'Plumbing for new construction' }, 'high-value', 'new construction'],
    [{ issue: 'Leaky faucet', job_type: 'Replace a faucet', job_size: 'Quick job (under 1 hr)' }, 'routine', 'faucet replace'],
    [{ issue: 'Toilet runs', job_type: 'Replace toilet', job_size: 'Standard job (1-3 hrs)' }, 'routine', 'toilet replace'],
    [{ issue: 'Replace the faucet by the water heater' }, 'routine', 'faucet near a water heater'],
    [{ issue: 'Something odd', job_size: 'Big job (half day+)' }, 'high-value', 'big job size'],
    [{ issue: 'Something odd', job_size: 'Unknown' }, 'routine', 'unknown size'],
    [{ issue: 'Main street address, drip under sink' }, 'routine', 'main without line'],
    [{ issue: 'Hung up before giving details' }, 'routine', 'hang-up with no job info'],
    [{}, 'routine', 'empty fields'],
    // job_type is Emma's label and wins over free text; free text is read only when job_type is empty.
    [{ issue: 'Wants a new water heater', job_type: 'Faucet repair' }, 'routine', 'job_type label wins over issue text'],
    [{ issue: 'Something odd', job_type: 'Tankless water heater install' }, 'high-value', 'tankless label'],
    [{ issue: 'Something odd', job_type: 'Sewer line replacement' }, 'high-value', 'sewer line label'],
    [{ issue: 'Toilet and tub gurgling', job_type: 'Sewer backup', job_size: 'Unknown' }, 'high-value', 'sewer backup label'],
    [{ issue: 'Sewage backing up into the basement floor drain' }, 'high-value', 'sewage backup'],
    [{ issue: 'Sewer smell in the basement', job_size: 'Quick job (under 1 hr)' }, 'routine', 'sewer smell'],
    [{ issue: 'No sewer backup, just a smell by the floor drain' }, 'routine', 'sewer backup negated'],
    [{ issue: 'Something odd', job_type: 'Bathroom remodel' }, 'high-value', 'remodel label'],
    // Negated or finished work never makes a job high-value.
    [{ issue: 'They do not need a new water heater, just the sink' }, 'routine', 'negated new water heater'],
    [{ issue: 'Drip from the water heater, not looking to replace it yet' }, 'routine', 'not looking to replace'],
    [{ issue: 'Just had a new water heater put in, now the faucet leaks' }, 'routine', 'had a new water heater put in'],
    [{ issue: 'Remodeled bathroom last year, toilet now running' }, 'routine', 'remodeled last year'],
    // One negated and one finished case per family.
    [{ issue: "Don't need a new water heater, the pilot light is out" }, 'routine', 'water heater negated'],
    [{ issue: 'Water heater was replaced in 2023, now it makes a noise' }, 'routine', 'water heater finished'],
    [{ issue: "Isn't interested in tankless, wants the tank fixed" }, 'routine', 'tankless negated'],
    [{ issue: 'Went tankless two years ago, now low pressure' }, 'routine', 'tankless finished'],
    [{ issue: 'No repipe needed, one leaky joint under the sink' }, 'routine', 'repipe negated'],
    [{ issue: 'House was repiped already, a valve drips' }, 'routine', 'repipe finished'],
    [{ issue: 'Main line is not backed up, only the tub drains slow' }, 'routine', 'main line negated'],
    [{ issue: 'Had the sewer line replaced last year, now a toilet clog' }, 'routine', 'sewer line finished'],
    [{ issue: 'Not doing a remodel, just a new faucet' }, 'routine', 'remodel negated'],
    [{ issue: 'Kitchen remodel finished last month, disposal jammed' }, 'routine', 'remodel finished'],
    // Main/sewer line needs work on the line itself; whole house alone describes a symptom.
    [{ issue: 'Replace the shutoff valve on the main water line' }, 'routine', 'valve on the main line'],
    [{ issue: 'Sewer line camera inspection' }, 'routine', 'inspection only'],
    [{ issue: 'Main line clog', job_size: 'Big job (half day+)' }, 'high-value', 'main line with Big job size'],
    [{ issue: 'Needs the main sewer line dug up and replaced' }, 'high-value', 'dig and replace'],
    [{ issue: 'Low pressure in the whole house' }, 'routine', 'whole house symptom'],
    [{ issue: 'Wants a whole-house water filter installed' }, 'high-value', 'whole-house filter'],
    [{ issue: '', job_type: '', job_size: '', job_details: '' }, 'routine', 'empty strings'],
  ];
  for (const [details, tier, why] of cases) assert.equal(priorityTier(details), tier, why);
});

test('the job card email shows the priority tier under the heading; the SMS is unchanged', () => {
  const route = { business: 'Gold Star Plumbing' };
  const base = { name: 'Linda Harper', address: '48 Birch Road', callback_phone: '6155550142', notes: [], job_type: '', job_size: '', job_details: '' };
  const big = { ...base, issue: 'Galvanized pipes rusting', job_type: 'Whole-house repipe', job_size: 'Big job (half day+)', preferred_time: 'Friday' };
  assert.match(alertText(route, big, 'new', 'email'), /^Anchorline AI: New call - Gold Star Plumbing\nPriority: High-value job\nLinda Harper/);
  assert.match(alertText(route, { ...base, issue: 'URGENT - burst pipe' }, 'new', 'email'), /^Anchorline AI: URGENT call - Gold Star Plumbing\nPriority: Urgent\n/);
  assert.match(alertText(route, { ...base, issue: 'Dripping faucet' }, 'new', 'email'), /^Anchorline AI: New call - Gold Star Plumbing\nPriority: Routine\n/);
  assert.match(alertText(route, { ...big, recording_url: 'https://example.com/r.wav' }, 'new', 'email'), /^Anchorline AI: New call - Gold Star Plumbing\nPriority: High-value job\nRecording: /);
  assert.doesNotMatch(alertText(route, { ...big, notes: ['Gate code'] }, 'note', 'email'), /Priority/);
  assert.doesNotMatch(alertText(route, { ...base, issue: 'Hung up before giving details', caller_id: '+16155550100' }, 'hangup', 'email'), /Priority/);
  for (const issue of ['URGENT - burst pipe', 'Dripping faucet']) assert.doesNotMatch(alertText(route, { ...base, issue }), /Priority/);
  assert.equal(alertText(route, big), 'Anchorline AI: New call - Gold Star Plumbing\nLinda Harper - (615) 555-0142\n48 Birch Road\nGalvanized pipes rusting\n' +
    'Job: Whole-house repipe - Big job (half day+)\nWants: Friday\nReply STOP to opt out');
  // A long high-value SMS keeps exactly main's (v1.8.0) text: same Job, Details and Wants content up to the 280-character cut.
  const long = { name: 'Dana Whitfield', address: '2210 Belmont Blvd, Nashville, TN 37212', issue: 'Water heater is 14 years old and leaking from the bottom',
    callback_phone: '6155550187', job_type: 'Water heater replacement', job_size: 'Big job (half day+)', notes: [],
    job_details: '50-gallon gas tank in the garage, wants a quote on tankless too', preferred_time: 'Tomorrow morning' };
  assert.equal(alertText(route, long), 'Anchorline AI: New call - Gold Star Plumbing\nDana Whitfield - (615) 555-0187\n2210 Belmont Blvd, Nashville, TN 37212\n' +
    'Water heater is 14 years old and leaking from the bottom\nJob: Water heater replacement - Big job (half day+)\nDetails: 50-gallon gas tank in the garage, wants a quot\nReply STOP to opt out');
});
