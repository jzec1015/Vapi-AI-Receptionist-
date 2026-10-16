import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ruleTags, callerWords, outOfArea, inBusinessHours, shouldRing } from './rules.mjs';
import { createApp, transcriptOf, readbackProblem } from './server.mjs';

// How Middle Tennessee callers actually say it (research notes: emma/research/plumber-rules-research-2026-10-16.md).
const SAID = {
  gas: ['I smell gas in the kitchen', 'it smells like rotten eggs by the stove', 'there is a gas leak I think', 'hissing by the water heater'],
  carbon_monoxide: ['the carbon monoxide alarm keeps going off', 'our CO detector is beeping'],
  injury: ['my son got burned by the hot water', 'I got shocked touching the faucet'],
  electrical_water: ['water is dripping out of the light fixture', 'there is water all around the outlets in the basement', 'the breaker box is wet'],
  active_water: ['a pipe burst in the crawl space', 'pipe froze and cracked, water all over the basement floor', 'the pipe under the sink blew',
    'the water heater is leaking really bad', 'no, it\'s flooding', 'not slow. water\'s gushing out', 'i don\'t know, the pipe burst', 'water is everywhere', 'water is coming through the ceiling', 'busted pipe under the house',
    'the basement is flooding', "I can't shut it off", 'the ceiling is sagging'],
  sewage_backup: ['sewage is coming up in the basement', 'when I flush it comes up in the tub', 'the commode is overflowing', 'sewer is backing up'],
  water_heater_leak: ['the water heater is pouring water', 'water coming out the pipe on the side of the water heater', 'the relief valve is spraying', 'the T&P valve is going off'],
  scalding: ['the water is way too hot, it scalded my hand'],
  sump_failure: ['the sump pump alarm is going off', 'sump pump quit and the basement is filling'],
  no_water: ["we don't have any water", 'nothing comes out of any of the faucets', 'our well pump is out', "the water's cut off"],
  frozen_pipe: ['I think the pipes froze last night'],
  no_hot_water: ['no hot water since yesterday'],
  slab_leak: ['there is a warm spot on the floor', 'our water bill went way up'],
  warranty_company: ["I'm calling from American Home Shield", 'this would go through my home warranty'],
  renter: ["I rent this place", 'my landlord said to call you'],
  spanish: ['¿habla español?', 'Spanish please', 'caller has limited English', 'I speak little English', "he doesn't speak much English"],
  existing_customer: ['I am calling about my appointment tomorrow', 'your guy was here Tuesday',
    'I had an appointment scheduled for today and the plumber hasn\'t shown up', 'job type: existing customer'],
  past_job: ['it is leaking again after you fixed it', "I'm not happy with the work"],
  wants_owner: ['can I talk to the owner', 'I want to speak to a real person'],
  price_asked: ['how much do you charge to come out', 'can I get a quote'],
  diy_advice: ['can you just tell me how to fix it', 'how do I replace a flapper'],
  sales_call: ['we help plumbers with Google ranking', 'I am calling about your marketing'],
  job_seeker: ['are you hiring plumbers'],
  commercial: ['it is at our restaurant on Main', 'the grease trap is full'],
  own_parts: ['I already bought the faucet']
};

test('every trigger hears the way callers say it', () => {
  for (const [tag, phrases] of Object.entries(SAID)) for (const p of phrases) assert.ok(ruleTags(p).includes(tag), `${tag}: "${p}" -> ${ruleTags(p)}`);
});

test('everyday calls do not trip an emergency', () => {
  for (const p of ['my toilet keeps running', 'kitchen sink is clogged', 'the water heater is leaking a little at the base', 'faucet drips',
    'water heater is making a popping noise', 'need a new garbage disposal installed', 'low water pressure in the shower', 'the sink is backed up',
    // From the code review: each of these was wrongly URGENT in the first draft.
    'basement flooded last spring, want a backup sump pump', 'i had a broken pipe fixed last year', 'install a floodlight by the garage',
    'water heater pilot light keeps going out', 'water heater breaker keeps tripping', 'we live in sparks', "we don't have water pressure upstairs",
    'nothing comes out of the outside spigot', 'hot water smells like rotten eggs', 'install an anti-scald valve', 't&p valve is dripping a little',
    'install a sewage ejector pump', 'the faucet handle is frozen', 'the disposal froze up'])
    assert.deepEqual(ruleTags(p).filter(t => !['price_asked', 'no_hot_water'].includes(t)), [], p);
});

test('a negation right before a trigger does not count', () => {
  for (const p of ['no one\'s been hurt or shocked', 'nobody got burned', 'no one has been hurt', 'no gas smell, just a clog', 'it is not flooding, just a drip', "there's no sewage, it's slow", 'nothing is frozen'])
    assert.deepEqual(ruleTags(p), [], p);
});

test('caller words come from the user turns of a tool-calls message', () => {
  const message = { artifact: { messages: [{ role: 'bot', message: 'Thanks for calling.' }, { role: 'user', message: 'my landlord said call' }, { role: 'user', message: 'water is everywhere' }] } };
  assert.equal(callerWords(message), 'my landlord said call water is everywhere');
  assert.equal(callerWords({}), '');
});

test('service area: a listed town or ZIP passes, anything else is flagged, an empty list checks nothing', () => {
  const area = 'Nashville, Murfreesboro, Mt. Juliet, 37211';
  assert.equal(outOfArea('412 Maple Dr, Murfreesboro TN', area), false);
  assert.equal(outOfArea('9 Elm St, Mt Juliet', area), false);
  assert.equal(outOfArea('48 Birch Rd, 37211', area), false);
  assert.equal(outOfArea('100 Main St, Clarksville TN 37040', area), true);
  assert.equal(outOfArea('100 Main St, Clarksville', ''), false);
});

test('after hours only the wake emergencies ring; in hours every urgent job rings', () => {
  const tuesdayNoon = new Date('2026-10-20T17:00:00Z'); // 12:00 in Nashville
  const tuesday2am = new Date('2026-10-20T07:00:00Z');
  const sunday = new Date('2026-10-18T17:00:00Z');
  assert.equal(inBusinessHours(tuesdayNoon), true);
  assert.equal(inBusinessHours(tuesday2am), false);
  assert.equal(inBusinessHours(sunday), false);
  assert.equal(shouldRing(['sewage_backup'], {}, tuesdayNoon), true);
  assert.equal(shouldRing(['sewage_backup'], {}, tuesday2am), false);
  assert.equal(shouldRing(['active_water', 'renter'], {}, tuesday2am), true);
  assert.equal(shouldRing([], {}, tuesday2am), true, 'URGENT with no known trigger still rings');
  assert.equal(shouldRing(['gas'], { wake: ['active_water', 'gas'] }, sunday), true);
  assert.equal(shouldRing(['no_water'], { hours: { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 24 } }, tuesday2am), true);
});

// Server: read-back check, keyword URGENT, flags on the alert and the after-hours ring rule.
const key = 'synthetic-test-key-not-used-in-production';
async function fixture(t, route) {
  const dir = mkdtempSync(join(tmpdir(), 'rules-test-'));
  const sent = [];
  const send = async (url, init) => { sent.push({ url, body: JSON.parse(init.body || '{}') }); return Response.json({ id: `ring-${sent.length}` }, { status: 201 }); };
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ALERT_ROUTES: JSON.stringify({ 'shop-a': route }), VAPI_API_KEY: 'fixture-only',
    ALERT_CALL_FROM_ID: 'from-line', RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com' }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); await new Promise(r => app.close(r)); rmSync(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) });
  const save = async (id, args, said = []) => JSON.parse((await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key },
    body: JSON.stringify({ message: { type: 'tool-calls', call: { id, assistantId: 'shop-a', customer: { number: '+16155550100' } },
      // The caller's words, then the callback read-back and their yes, so the server's read-back check passes.
      artifact: { messages: said.length ? [...said.map(message => ({ role: 'user', message })),
        { role: 'bot', message: "So that's 6 1 5, 5 5 5, 0 1 4 2?" }, { role: 'user', message: 'Yes.' }] : [] },
      toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } }) })).json()).results[0].result);
  return { post, save, sent, rings: () => sent.filter(s => s.url === 'https://api.vapi.ai/call'), emails: () => sent.filter(s => s.url.includes('resend')) };
}
const job = { name: 'Linda Harper', address: '1412 Dickerson Pike, Nashville, TN 37207', issue: 'Kitchen sink', is_test: false,
  callback_phone: '6155550142', callback_read_back: true, email_status: 'declined' };
const always = { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 24 };
const never = { days: [], start: 0, end: 0 };

test('a number that was not read back goes back once, then saves with a flag', async t => {
  const { save, emails } = await fixture(t, { business: 'Riverbend Plumbing', email: ['office@example.com'], hours: always });
  const first = await save('rb', { ...job, callback_read_back: false });
  assert.equal(first.saved, false);
  assert.match(first.error, /read the callback number back first/);
  assert.equal((await save('rb', { ...job, callback_read_back: false })).saved, true);
  assert.match(emails()[0].body.text, /Flags: Callback number was not read back/);
});

test('the transcript decides the read-back: a read-back with no answer goes back once, then saves with a flag', async t => {
  const { save, post, emails } = await fixture(t, { business: 'Riverbend Plumbing', email: ['office@example.com'], hours: always });
  const body = (id, messages) => ({ message: { type: 'tool-calls', call: { id, assistantId: 'shop-a', customer: { number: '+16155550100' } },
    artifact: { messages }, toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: job } }] } });
  const asked = [{ role: 'user', message: 'six one five five five five oh one four two' }, { role: 'bot', message: "So that's 6 1 5, 5 5 5, 0 1 4 2?" }];
  const first = await save('tx', job, []);
  assert.equal(first.saved, true, 'an empty transcript falls back to Emma\'s flag');
  const refused = JSON.parse((await (await post(body('tx2', asked))).json()).results[0].result);
  assert.equal(refused.saved, false);
  assert.match(refused.error, /wait for the caller to say yes/);
  const second = JSON.parse((await (await post(body('tx2', asked))).json()).results[0].result);
  assert.equal(second.saved, true);
  assert.match(emails().at(-1).body.text, /Flags: Callback number was not read back/);
});

test('transcriptOf finds the conversation wherever the payload carries it', () => {
  const m = [{ role: 'user', message: 'hi' }];
  assert.deepEqual(transcriptOf({ artifact: { messages: m } }), m);
  assert.deepEqual(transcriptOf({ call: { artifact: { messages: m } } }), m);
  assert.deepEqual(transcriptOf({ artifact: { messages: [], messagesOpenAIFormatted: [{ role: 'user', content: 'hi' }] } }), [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(transcriptOf({ artifact: { messages: [] } }), [], 'empty, not missing');
  assert.equal(transcriptOf({}), null);
  assert.equal(readbackProblem([{ role: 'user', content: '615 555 0142' }, { role: 'assistant', content: "So that's six one five, five five five, oh one four two?" }, { role: 'user', content: 'yes' }], '6155550142', false), null, 'OpenAI-format roles work');
});

test('an emergency in the caller\'s words makes the job URGENT even when Emma left the prefix off', async t => {
  const { save, rings, emails } = await fixture(t, { business: 'Riverbend Plumbing', email: ['office@example.com'], call: ['+15550000999'], hours: always });
  assert.equal((await save('flood', { ...job, issue: 'Leak in the crawl space', email_status: 'declined' }, ['a pipe burst under the house, water everywhere'])).saved, true);
  assert.match(emails()[0].body.subject, /^URGENT/);
  assert.equal(rings().length, 1);
});

test('after hours a sewage job emails URGENT now but does not ring; a flood does', async t => {
  const { save, rings, emails } = await fixture(t, { business: 'Riverbend Plumbing', email: ['office@example.com'], call: ['+15550000999'], hours: never });
  await save('sewage', { ...job, issue: 'URGENT - sewage coming up in the tub', email_status: 'skipped_emergency' });
  assert.match(emails()[0].body.subject, /^URGENT/);
  assert.equal(rings().length, 0);
  await save('burst', { ...job, issue: 'URGENT - burst pipe', email_status: 'skipped_emergency' });
  assert.equal(rings().length, 1);
});

test('flags reach the owner: renter, warranty company, Spanish speaker, out of area', async t => {
  const { save, emails } = await fixture(t, { business: 'Riverbend Plumbing', email: ['office@example.com'], hours: always, service_area: 'Nashville, Murfreesboro' });
  await save('flags', { ...job, address: '100 Main St, Clarksville TN', job_details: 'Renter; landlord is Pat' }, ['American Home Shield sent me', 'habla español']);
  const text = emails()[0].body.text;
  for (const flag of [/Renter/, /Home warranty company/, /Spanish speaker/, /not in the service area/]) assert.match(text, flag);
});

test('a gas caller who hangs up to leave the house still reaches the owner as URGENT', async t => {
  const { post, emails } = await fixture(t, { business: 'Riverbend Plumbing', email: ['office@example.com'], hours: always });
  await post({ message: { type: 'end-of-call-report', durationSeconds: 35, endedReason: 'customer-ended-call',
    call: { id: 'gas-hangup', assistantId: 'shop-a', type: 'inboundPhoneCall', customer: { number: '+16155550100' } },
    analysis: { summary: 'Caller said they smell gas in the kitchen; Emma told them to leave and call 911.' } } });
  assert.match(emails()[0].body.subject, /^URGENT: caller hung up/);
  assert.match(emails()[0].body.text, /URGENT: caller hung up/);
});

test('review fixes: sales pitches stay non-urgent, the caller\'s own number is not sent back, a note can make a job URGENT', async t => {
  const { post, save, rings, emails } = await fixture(t, { business: 'Riverbend Plumbing', email: ['office@example.com'], call: ['+15550000999'], hours: always });
  const pitch = await save('pitch', { ...job, issue: 'Not a job - marketing call', callback_phone: '' }, ['we get plumbers more flood calls with Google ranking']);
  assert.equal(pitch.saved, true);
  assert.doesNotMatch(emails()[0].body.subject, /URGENT/);
  assert.equal((await save('own', { ...job, callback_phone: '+16155550100', callback_read_back: false })).saved, true);
  assert.equal((await save('later', job)).urgent, undefined);
  const note = await post({ message: { type: 'tool-calls', call: { id: 'later', assistantId: 'shop-a', customer: { number: '+16155550100' } },
    toolCallList: [{ id: 'tool-2', function: { name: 'add_request_note', arguments: { note: 'Now water is coming through the ceiling' } } }] } });
  assert.equal(JSON.parse((await note.json()).results[0].result).urgent, true);
  assert.equal(rings().length, 1);
  assert.match(emails().at(-1).body.subject, /^URGENT update/);
});

test('a Spanish speaker\'s save needs no email', async t => {
  const { save } = await fixture(t, { business: 'Riverbend Plumbing', email: ['office@example.com'], hours: always });
  const result = await save('es', { ...job, issue: 'Kitchen leak', job_details: 'Caller has limited English', email_status: 'skipped_emergency' });
  assert.equal(result.saved, true, JSON.stringify(result));
});
