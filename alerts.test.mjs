import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp, alertText, priorityTier } from './server.mjs';

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
    [{ issue: 'No hot water', job_type: 'Water heater repair', job_details: 'Pilot light keeps going out' }, 'routine', 'water heater repair is not high-value'],
    [{ issue: 'Water heater repair' }, 'routine', 'water heater repair alone'],
    [{ issue: 'Replaced the water heater last year, now a drip under the sink' }, 'routine', 'past replacement, different problem'],
    [{ issue: 'Water heater was replaced in May, pilot light keeps going out' }, 'routine', 'was replaced'],
    [{ issue: 'Water heater is fine. Replace the kitchen faucet' }, 'routine', 'replace in another sentence'],
    [{ issue: 'Pilot light out' }, 'routine', 'pilot light alone'],
    [{ issue: 'Old galvanized pipes', job_type: 'Whole-house repipe' }, 'high-value', 'repipe'],
    [{ issue: 'Needs repiping', job_size: 'Unknown' }, 'high-value', 'repiping'],
    [{ issue: 'Backups in every drain', job_details: 'Main line clogged with roots' }, 'high-value', 'main line'],
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
