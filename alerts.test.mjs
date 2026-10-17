import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp, alertText, alertSubject, digestEmail, confirmedCallback, transcriptExcerpt, priorityTier, callbackNumbers, callbackText, spokenCallback } from './server.mjs';

const key = 'synthetic-test-key-not-used-in-production';
const routes = JSON.stringify({ 'client-a': { business: 'Gold Star Plumbing', sms: ['+15550000001'], email: ['office@example.com'] } });
const alertEnv = { ALERT_ROUTES: routes, TELNYX_API_KEY: 'fixture-only', TELNYX_FROM: '+15550000000', RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com' };
const intake = { name: 'Linda Harper', address: '48 Birch Road', issue: 'URGENT - water under kitchen sink', is_test: false, callback_phone: '6155550142', callback_read_back: true };
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
  return { post, sent, dir };
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

// Emma's submit_service_request call as Vapi logs it in artifact.messages (the shape of a real Gold Star test call), and
// the same call as artifact.messagesOpenAIFormatted carries it.
const saveArgs = extra => JSON.stringify({ name: 'Linda Harper', address: '48 Birch Road', issue: 'Water heater leaking', is_test: false, email: '', ...extra });
const vapiSave = (extra, id = 'call_1') => [{ role: 'tool_calls', message: '', toolCalls: [{ id, type: 'function', function: { name: 'submit_service_request', arguments: saveArgs(extra) } }] },
  { role: 'tool_call_result', name: 'submit_service_request', toolCallId: id, result: '{"saved":false,"retryable":true,"error":"Not saved"}' }];
const openAiSave = (extra, id = 'call_1') => [{ role: 'assistant', tool_calls: [{ id, type: 'function', function: { name: 'submit_service_request', arguments: saveArgs(extra) } }] },
  { role: 'tool', tool_call_id: id, content: '{"saved":false,"retryable":true,"error":"Not saved"}' }];
const ASK = ['bot', 'So that’s six one five, five five five, oh one four two?'];
const READ_BACK = { callback_phone: '6155550142', callback_read_back: true };
const storedLead = (dir, callId) => {
  const db = new DatabaseSync(join(dir, 'requests.sqlite'), { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT details FROM requests WHERE call_id = ?').get(callId).details); } finally { db.close(); }
};

test('a hang-up after a failed save takes the confirmed number from Emma’s own save call and keeps the transcript', async t => {
  const { post, sent, dir } = await fixture(t);
  const artifact = said(['bot', 'Hi, thanks for calling Gold Star Plumbing. How can I help?'], ['user', 'My water heater is leaking all over the garage.'],
    ['bot', "What's the best number to call you back?"], ['user', '615 555 0142.'], ASK, ['user', "Yeah, that's it."],
    ['bot', 'Sorry, our system is down. The team will call you back at six one five, five five five, oh one four two.'], ['user', 'Okay, thanks.']);
  artifact.messages.splice(7, 0, ...vapiSave(READ_BACK));
  await post(hangupReport('hang-readback', artifact));
  const email = sent.find(s => s.url.includes('resend')).body;
  assert.equal(email.subject, 'Caller hung up – (615) 555-0142 – call them back');
  assert.match(email.text, /Unknown caller - \(615\) 555-0142 \(confirmed on the call; caller ID \(615\) 555-0100\)\n/);
  assert.match(email.text, /Hung up before finishing\nTranscript \(end of call\):\nAI: Hi, thanks[\s\S]*User: My water heater is leaking all over the garage\./);
  assert.match(sent.find(s => s.url.includes('telnyx')).body.text,
    /^Anchorline AI: Caller hung up - Gold Star Plumbing\nUnknown caller - \(615\) 555-0142 \(confirmed on the call; caller ID \(615\) 555-0100\)\n/);
  const lead = storedLead(dir, 'hang-readback');
  assert.equal(lead.callback_phone, '6155550142'); assert.equal(lead.callback_source, 'tool');
});

test('a read-back and a yes in the transcript alone are never called confirmed: the office gets the caller ID', async t => {
  const { post, sent, dir } = await fixture(t);
  await post(hangupReport('hang-numerals', { transcript: 'AI: Is 615-555-0177 the best number?\nUser: Correct.\nAI: And the address?' },
    { analysis: { summary: 'Caller reported a leak.' } }));
  await post(hangupReport('hang-yes', said(ASK, ['user', 'Yes.'], ['bot', 'And the address?'])));
  const emails = sent.filter(s => s.url.includes('resend')).map(s => s.body);
  for (const email of emails) {
    assert.equal(email.subject, 'Caller hung up – (615) 555-0100 – call them back');
    assert.match(email.text, /Unknown caller - \(615\) 555-0100 \(caller ID\)\n/); assert.doesNotMatch(email.text, /confirmed|not verified/);
  }
  assert.match(emails[0].text, /Hung up before finishing\. Summary: Caller reported a leak\.\nTranscript \(end of call\):\nAI: Is 615-555-0177/);
  for (const sms of sent.filter(s => s.url.includes('telnyx'))) assert.equal(sms.body.text.split('\n')[1], 'Unknown caller - (615) 555-0100 (caller ID)');
  const lead = storedLead(dir, 'hang-yes');
  assert.equal(lead.callback_phone, ''); assert.equal(lead.callback_source, '');
});

test('a hang-up report without a transcript is the same lead as before', async t => {
  const { post, sent } = await fixture(t);
  await post(hangupReport('hang-bare', undefined));
  const email = sent.find(s => s.url.includes('resend')).body;
  assert.equal(email.subject, 'Caller hung up – (615) 555-0100 – call them back');
  assert.match(email.text, /\(615\) 555-0100 \(caller ID\)\nHung up before giving details\n\nRequest reference: /);
});

test('a save call with a test caller number keeps the hang-up suppressed', async t => {
  const { post, sent } = await fixture(t, { TEST_CALLER_NUMBERS: '+16155550142' });
  const artifact = said(ASK, ['user', 'Yep.']);
  artifact.messages.push(...vapiSave(READ_BACK));
  await post(hangupReport('hang-testnum', artifact));
  assert.equal(sent.length, 0);
});

test('confirmedCallback: only Emma’s last submit_service_request call with callback_read_back true', () => {
  const N = '6155550142';
  const vapi = (...parts) => ({ artifact: { messages: parts.flat() } });
  const turns = (...list) => list.map(([role, message]) => ({ role, message }));
  // Both message shapes Vapi sends; arguments as a JSON string or an object.
  assert.equal(confirmedCallback(vapi(turns(ASK, ['user', 'Yes.']), vapiSave(READ_BACK))), N);
  assert.equal(confirmedCallback({ artifact: { messagesOpenAIFormatted: [{ role: 'assistant', content: ASK[1] }, { role: 'user', content: 'Yes.' }, ...openAiSave(READ_BACK)] } }), N);
  assert.equal(confirmedCallback({ messages: [...openAiSave(READ_BACK)] }), N);
  assert.equal(confirmedCallback(vapi([{ role: 'tool_calls', toolCalls: [{ function: { name: 'submit_service_request', arguments: READ_BACK } }] }])), N);
  // Normalised to 10 digits; anything that is not one US number is not used.
  for (const phone of ['(615) 555-0142', '+1 615-555-0142', '1.615.555.0142']) assert.equal(confirmedCallback(vapi(vapiSave({ ...READ_BACK, callback_phone: phone }))), N, phone);
  for (const phone of ['', '555-0142', '615 555 0142 ext 3', 'six one five five five five oh one four two', '615 555 0142 or 615 555 0199', '0155550142'])
    assert.equal(confirmedCallback(vapi(vapiSave({ ...READ_BACK, callback_phone: phone }))), '', phone);
  // callback_read_back must be exactly true.
  for (const flag of [false, 'true', undefined]) assert.equal(confirmedCallback(vapi(vapiSave({ callback_phone: N, callback_read_back: flag }))), '', String(flag));
  // The last save call decides, even when an earlier one had a different number or a read-back.
  assert.equal(confirmedCallback(vapi(vapiSave(READ_BACK, 'a'), vapiSave({ callback_phone: '6155550199', callback_read_back: true }, 'b'))), '6155550199');
  assert.equal(confirmedCallback(vapi(vapiSave(READ_BACK, 'a'), vapiSave({ callback_phone: '', callback_read_back: false }, 'b'))), '');
  // Other tools, results, broken arguments and user turns are not save calls.
  assert.equal(confirmedCallback(vapi([{ role: 'tool_calls', toolCalls: [{ function: { name: 'add_request_note', arguments: saveArgs(READ_BACK) } }] }])), '');
  assert.equal(confirmedCallback(vapi([{ role: 'tool_call_result', name: 'submit_service_request', result: saveArgs(READ_BACK) }])), '');
  assert.equal(confirmedCallback(vapi([{ role: 'tool_calls', toolCalls: [{ function: { name: 'submit_service_request', arguments: '{"callback_phone":"6155550142",' } }] }])), '');
  assert.equal(confirmedCallback(vapi([{ role: 'user', toolCalls: [{ function: { name: 'submit_service_request', arguments: saveArgs(READ_BACK) } }] }])), '');
  assert.equal(confirmedCallback({}), '');
  // Retractions in the transcript never yield a confirmed number without a save call (grader rounds 1-3), however worded.
  const later = reply => vapi(turns(ASK, ['user', 'Yes.'], ['bot', 'And the address?'], ['user', reply]));
  for (const reply of ['Yes.', 'Mhm.', "Yeah, that's it.", 'Yes. Scratch that.', 'Yes. Never mind, use my work line.', 'Yes. Hang on.', 'Yeah, um, let me check.',
    'Yes, or maybe my other cell.', 'Correct, well, almost.', 'Yes, I think so.', 'Yes, but it ends in 43.'])
    assert.equal(confirmedCallback(vapi(turns(ASK, ['user', reply]))), '', reply);
  for (const reply of ['Hold on, scratch that number.', 'Hmm, I gave you my old one.', "That number's off by one digit.", 'Oh, the area code is actually 555.'])
    assert.equal(confirmedCallback(later(reply)), '', reply);
  assert.equal(confirmedCallback(vapi(turns(['bot', 'Is our number 615 555 0100 the one you called?'], ['user', 'Yes.']))), '');
  // A retraction after Emma's save call: the save call is what Emma submitted after the caller's yes, so it still stands.
  assert.equal(confirmedCallback(vapi(turns(ASK, ['user', 'Yes.']), vapiSave(READ_BACK), turns(['user', 'Scratch that.']))), N);
});

test('hang-up labels: confirmed only for a save call; an older stored number is not verified', () => {
  const route = { business: 'Gold Star Plumbing' };
  const lead = extra => ({ name: 'Unknown caller', address: '', issue: 'Hung up before finishing', caller_id: '+16155550100', ...extra });
  const tool = lead({ callback_phone: '6155550142', callback_source: 'tool' });
  assert.match(alertText(route, tool, 'hangup'), /\nUnknown caller - \(615\) 555-0142 \(confirmed on the call; caller ID \(615\) 555-0100\)\n/);
  assert.match(alertText(route, tool, 'hangup', 'email'), /\nUnknown caller - \(615\) 555-0142 \(confirmed on the call; caller ID \(615\) 555-0100\)\n/);
  assert.match(alertText(route, lead({ callback_phone: '6155550100', callback_source: 'tool' }), 'hangup'), /\nUnknown caller - \(615\) 555-0100 \(confirmed on the call\)\n/);
  assert.equal(alertSubject(tool, 'hangup'), 'Caller hung up – (615) 555-0142 – call them back');
  // A hang-up stored before callback_source existed (an older transcript rule picked the number): never "confirmed".
  const old = lead({ callback_phone: '6155550142' });
  for (const channel of ['sms', 'email']) {
    const text = alertText(route, old, 'hangup', channel);
    assert.match(text, /\nUnknown caller - \(615\) 555-0142 \(from the call transcript, not verified; caller ID \(615\) 555-0100\)\n/); assert.doesNotMatch(text, /confirmed/);
  }
  assert.equal(alertSubject(old, 'hangup'), 'Caller hung up – (615) 555-0142 (not verified) – call them back');
  const none = lead({ callback_phone: '', callback_source: '' });
  assert.match(alertText(route, none, 'hangup'), /\nUnknown caller - \(615\) 555-0100 \(caller ID\)\n/);
  assert.equal(alertSubject(none, 'hangup'), 'Caller hung up – (615) 555-0100 – call them back');
  const { text } = digestEmail(route, 'Thursday, October 15', { calls: 3, jobs: [], hangups: [{ details: tool }, { details: old }, { details: none }] });
  assert.match(text, /Hang-ups: 3\n- \(615\) 555-0142 \(confirmed on the call\) – call them back\n- \(615\) 555-0142 \(from the call transcript, not verified\) – call them back\n- \(615\) 555-0100 – call them back\n/);
});

test('transcript excerpt: length, speaker tag, empty report', () => {
  const turn = { artifact: { transcript: `AI: Hi.\nUser: ${'blah '.repeat(400)}the end` } };
  assert.match(transcriptExcerpt(turn), /^…User: …blah/); assert.ok(transcriptExcerpt(turn).length <= 1500);
  const long = { artifact: { transcript: Array.from({ length: 80 }, (_, i) => `${i % 2 ? 'User' : 'AI'}: line ${i} of the call`).join('\n') } };
  const excerpt = transcriptExcerpt(long);
  assert.ok(excerpt.length <= 1500); assert.match(excerpt, /^…(AI|User): line \d+/); assert.match(excerpt, /User: line 79 of the call$/);
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

test('the job card email shows the priority tier under the heading; the SMS has no tier', () => {
  const route = { business: 'Gold Star Plumbing' };
  const base = { name: 'Linda Harper', address: '48 Birch Road', callback_phone: '6155550142', callback_source: 'tool', notes: [], job_type: '', job_size: '', job_details: '' };
  const big = { ...base, issue: 'Galvanized pipes rusting', job_type: 'Whole-house repipe', job_size: 'Big job (half day+)', preferred_time: 'Friday' };
  assert.match(alertText(route, big, 'new', 'email'), /^Anchorline AI: New call - Gold Star Plumbing\nPriority: High-value job\nLinda Harper/);
  assert.match(alertText(route, { ...base, issue: 'URGENT - burst pipe' }, 'new', 'email'), /^Anchorline AI: URGENT call - Gold Star Plumbing\nPriority: Urgent\n/);
  assert.match(alertText(route, { ...base, issue: 'Dripping faucet' }, 'new', 'email'), /^Anchorline AI: New call - Gold Star Plumbing\nPriority: Routine\n/);
  assert.match(alertText(route, { ...big, recording_url: 'https://example.com/r.wav' }, 'new', 'email'), /^Anchorline AI: New call - Gold Star Plumbing\nPriority: High-value job\nRecording: /);
  assert.doesNotMatch(alertText(route, { ...big, notes: ['Gate code'] }, 'note', 'email'), /Priority/);
  assert.doesNotMatch(alertText(route, { ...base, issue: 'Hung up before giving details', caller_id: '+16155550100' }, 'hangup', 'email'), /Priority/);
  for (const issue of ['URGENT - burst pipe', 'Dripping faucet']) assert.doesNotMatch(alertText(route, { ...base, issue }), /Priority/);
  assert.equal(alertText(route, big), 'Anchorline AI: New call - Gold Star Plumbing\nLinda Harper - (615) 555-0142 (confirmed on the call)\n48 Birch Road\nGalvanized pipes rusting\n' +
    'Job: Whole-house repipe - Big job (half day+)\nWants: Friday\nReply STOP to opt out');
  // A long high-value SMS keeps main's (v1.8.0) lines up to the 280-character cut; the number now says it was confirmed on the call.
  const long = { name: 'Dana Whitfield', address: '2210 Belmont Blvd, Nashville, TN 37212', issue: 'Water heater is 14 years old and leaking from the bottom',
    callback_phone: '6155550187', callback_source: 'tool', job_type: 'Water heater replacement', job_size: 'Big job (half day+)', notes: [],
    job_details: '50-gallon gas tank in the garage, wants a quote on tankless too', preferred_time: 'Tomorrow morning' };
  assert.equal(alertText(route, long), 'Anchorline AI: New call - Gold Star Plumbing\nDana Whitfield - (615) 555-0187 (confirmed on the call)\n2210 Belmont Blvd, Nashville, TN 37212\n' +
    'Water heater is 14 years old and leaking from the bottom\nJob: Water heater replacement - Big job (half day+)\nDetails: 50-gallon gas tank in \nReply STOP to opt out');
});

test('callbackNumbers: callback_phone is the callback number only when saved with callback_read_back true (callback_source tool)', () => {
  const job = extra => ({ name: 'Linda Harper', address: '48 Birch Road', issue: 'URGENT - burst pipe', notes: ['Gate code 4471'], caller_id: '+16155550100', ...extra });
  const confirmed = job({ callback_phone: '6155550199', callback_source: 'tool' });
  assert.deepEqual(callbackNumbers(confirmed), { confirmed: '(615) 555-0199', callerId: '(615) 555-0100', unconfirmed: '', other: true });
  assert.equal(callbackText(confirmed), '(615) 555-0199 (confirmed on the call; caller ID (615) 555-0100)');
  assert.equal(spokenCallback(confirmed), 'Callback number: (615) 555-0199.');
  assert.equal(spokenCallback(confirmed, 'transfer'), 'Their callback number is (615) 555-0199.');
  // Not read back (no callback_source, or anything but 'tool'): the caller ID, said as "calling from".
  for (const source of [undefined, '', 'transcript']) {
    const notRead = job({ callback_phone: '6155550199', callback_source: source });
    assert.equal(callbackText(notRead), '(615) 555-0100 (caller ID; gave (615) 555-0199, not confirmed)', String(source));
    assert.equal(spokenCallback(notRead), 'They were calling from (615) 555-0100. Their callback number wasn\'t confirmed, so check your email.');
    assert.equal(spokenCallback(notRead, 'transfer'), 'They\'re calling from (615) 555-0100.');
    assert.equal(alertSubject(notRead), 'URGENT – burst pipe – 48 Birch Road – (615) 555-0100 (caller ID)');
    assert.equal(alertSubject(notRead, 'note'), 'URGENT update – Gate code 4471 – 48 Birch Road – (615) 555-0100 (caller ID)');
  }
  const none = job({ callback_phone: '' });
  assert.equal(callbackText(none), '(615) 555-0100 (caller ID)');
  assert.equal(spokenCallback(none), 'They were calling from (615) 555-0100. They didn\'t give a callback number.');
  // A blocked or empty caller ID is no caller ID.
  for (const caller_id of ['', undefined, 'anonymous', 'Restricted', 'sip:anonymous@example.com', '+266696687', '+1266696687', '+17378742833', '+86282452253', '+8656696', '+10000000000', '0000000000', '+1 ']) {
    const blocked = job({ callback_phone: '', caller_id });
    assert.equal(callbackNumbers(blocked).callerId, '', String(caller_id));
    assert.equal(callbackText(blocked), 'no number given (no caller ID)');
    assert.equal(spokenCallback(blocked), 'There\'s no number for them and no caller ID, so check your email.');
    assert.equal(spokenCallback(blocked, 'transfer'), 'There\'s no number for them and no caller ID, so check your email after the call.');
    assert.equal(alertSubject(blocked), 'URGENT – burst pipe – 48 Birch Road – no number given');
    assert.equal(alertText({ business: 'Gold Star Plumbing' }, blocked).split('\n')[1], 'Linda Harper - no number given (no caller ID)');
    const given = job({ callback_phone: '6155550199', caller_id });
    assert.equal(callbackText(given), '(615) 555-0199 (not confirmed; no caller ID)');
    assert.equal(spokenCallback(given), 'There\'s no confirmed callback number and no caller ID, so check your email.');
    assert.equal(alertSubject(given), 'URGENT – burst pipe – 48 Birch Road – (615) 555-0199 (not confirmed)');
  }
});

test('the SMS and email card label every number the same way; hang-up leads keep their own labels', () => {
  const route = { business: 'Gold Star Plumbing' };
  const job = { name: 'Linda Harper', address: '48 Birch Road', issue: 'URGENT - burst pipe', notes: ['Gate code 4471'], caller_id: '+16155550100' };
  const cases = [
    [{ callback_phone: '6155550199', callback_source: 'tool' }, 'Linda Harper - (615) 555-0199 (confirmed on the call; caller ID (615) 555-0100)'],
    [{ callback_phone: '6155550100', callback_source: 'tool' }, 'Linda Harper - (615) 555-0100 (confirmed on the call)'],
    [{ callback_phone: '6155550199' }, 'Linda Harper - (615) 555-0100 (caller ID; gave (615) 555-0199, not confirmed)'],
    [{ callback_phone: '6155550100' }, 'Linda Harper - (615) 555-0100 (caller ID; also the number they gave, not confirmed)'],
    [{ callback_phone: '' }, 'Linda Harper - (615) 555-0100 (caller ID)']
  ];
  for (const [extra, line] of cases) for (const kind of ['new', 'note']) for (const channel of ['sms', 'email'])
    assert.equal(alertText(route, { ...job, ...extra }, kind, channel).split('\n').find(l => l.startsWith('Linda Harper')), line, `${kind} ${channel} ${JSON.stringify(extra)}`);
  // The SMS keeps its GSM-7 alphabet and 280-character cut with the longest label.
  const sms = alertText(route, { ...job, callback_phone: '6155550199', callback_source: 'tool', issue: 'URGENT - ' + 'water everywhere '.repeat(30) });
  assert.ok(sms.length <= 280 + '\nReply STOP to opt out'.length); assert.match(sms, /^[\n\x20-\x7E]+$/);
  // Hang-up leads are unchanged (hangupCallbackLabel).
  assert.equal(alertText(route, { ...job, issue: 'Hung up', callback_phone: '', callback_source: '' }, 'hangup').split('\n')[1], 'Linda Harper - (615) 555-0100 (caller ID)');
  assert.equal(alertText(route, { ...job, issue: 'Hung up', callback_phone: '6155550199', callback_source: 'tool' }, 'hangup').split('\n')[1],
    'Linda Harper - (615) 555-0199 (confirmed on the call; caller ID (615) 555-0100)');
});

test('a saved job keeps callback_source tool only when Emma sent callback_read_back true with a 10-digit number', async t => {
  const { post, dir } = await fixture(t);
  const saves = { 'rb-1': { callback_read_back: true }, 'rb-2': { callback_read_back: false }, 'rb-3': {}, 'rb-4': { callback_read_back: 'true' },
    'rb-5': { callback_phone: '555-0199', callback_read_back: true }, 'rb-6': { callback_phone: '', callback_read_back: true } };
  for (const [id, extra] of Object.entries(saves)) await post(toolCall(id, 'submit_service_request', { ...intake, callback_read_back: undefined, ...extra }));
  const db = new DatabaseSync(join(dir, 'requests.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const source = id => JSON.parse(db.prepare('SELECT details FROM requests WHERE call_id = ?').get(id).details).callback_source;
  assert.deepEqual(Object.keys(saves).map(source), ['tool', '', '', '', '', '']);
});

test('a subject never cuts the "(not confirmed)" or "(caller ID)" label, even for a 100-character number', () => {
  const long = '615 555 0142 or my wifes cell 615 555 0199 after five, or the shop line 615 555 0123 thanks, ok byee';
  assert.equal(long.length, 100);
  const job = { name: 'Dana', address: '12 Main St, Nashville, TN', issue: 'URGENT - burst pipe', notes: [], callback_phone: long };
  for (const caller_id of ['anonymous', '', '+266696687']) {
    for (const [kind, head] of [['new', 'URGENT – '], ['unanswered', 'UNANSWERED URGENT – ']]) {
      const subject = alertSubject({ ...job, caller_id }, kind);
      assert.ok(subject.length <= 90, subject);
      assert.ok(subject.startsWith(`${head}burst pipe – 12 Main St – `), subject);
      assert.ok(subject.endsWith(' (not confirmed)'), subject);
      assert.equal(subject, `${head}burst pipe – 12 Main St – 615 555 0142 or my… (not confirmed)`);
    }
  }
  // A long, non-US caller ID keeps its label the same way.
  const id = alertSubject({ ...job, callback_phone: '', caller_id: '+44 20 7946 0958 0000 0000 0000 0000 0000' }, 'unanswered');
  assert.ok(id.length <= 90 && id.startsWith('UNANSWERED URGENT – burst pipe') && id.endsWith(' (caller ID)'), id);
  // The note subject and a confirmed number are unchanged.
  assert.ok(alertSubject({ ...job, caller_id: '', notes: ['Gate code 4471'] }, 'note').endsWith(' (not confirmed)'));
  assert.equal(alertSubject({ ...job, callback_phone: '6155550142', callback_source: 'tool', caller_id: '' }), 'URGENT – burst pipe – 12 Main St – (615) 555-0142');
});

test('a number they gave that equals the caller ID but was not read back is stated plainly in writing', () => {
  const route = { business: 'Gold Star Plumbing' };
  const job = { name: 'Linda Harper', address: '48 Birch Road', issue: 'URGENT - burst pipe', notes: [], caller_id: '+16155550100', callback_phone: '615-555-0100' };
  assert.equal(callbackText(job), '(615) 555-0100 (caller ID; also the number they gave, not confirmed)');
  assert.equal(spokenCallback(job), 'They were calling from (615) 555-0100. Their callback number wasn\'t confirmed, so check your email.');
  for (const channel of ['sms', 'email']) assert.equal(alertText(route, job, 'new', channel).split('\n').find(l => l.startsWith('Linda')), 'Linda Harper - (615) 555-0100 (caller ID; also the number they gave, not confirmed)');
  assert.equal(alertSubject(job), 'URGENT – burst pipe – 48 Birch Road – (615) 555-0100 (caller ID)');
});
