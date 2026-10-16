import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp, garbledHouseNumber, spokenDigits, readbackProblem } from './server.mjs';

const key = 'synthetic-test-key-not-used-in-production';
const details = { name: 'Synthetic Test', address: '2 42 4 0 Elm Street, Nashville', issue: 'Synthetic verification', is_test: true };
const payload = (id, args) => ({ message: { type: 'tool-calls', call: { id }, toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } });
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'receptionist-test-'));
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key }, async () => { throw new Error('Unexpected outbound request'); });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  return async body => JSON.parse((await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) })).json()).results[0].result);
}

test('only clearly garbled house numbers are flagged', () => {
  for (const a of ['2 42 4 0 Elm Street', '12345678 Oak Ave', '1 2 3 4 5 6 7 Elm St', '4 42 1 Pine Rd']) assert.equal(garbledHouseNumber(a), true, a);
  for (const a of ['24240 Elm Street', '100 200 Main St', '12-14 Main St', '742 Evergreen Terrace', 'Not given', '', 'Route 9, Lebanon', '5 Oak Ct', '3rd Ave N', '5 0 1 Woodland Street', '1 2 3 Main St', '4-4-1 Pine Rd'])
    assert.equal(garbledHouseNumber(a), false, a);
});

test('a garbled house number is sent back once, then saved so no caller is lost', async t => {
  const post = await fixture(t);
  const first = await post(payload('garbled', details));
  assert.equal(first.saved, false);
  assert.match(first.error, /house number/);
  assert.equal((await post(payload('garbled', details))).saved, true);
  assert.equal((await post(payload('clean', { ...details, address: '24240 Elm Street, Nashville' }))).saved, true);
});

test('spoken and written digits are read the same way', () => {
  assert.equal(spokenDigits('So that\'s six one five, five five five, oh one four four?'), '6155550144');
  assert.equal(spokenDigits('6 1 5, double five 5, 0 1 4 4'), '6155550144');
});

const said = (...turns) => turns.map(([role, message]) => ({ role, message }));
test('a save needs the callback number read back and answered', () => {
  const phone = '615-555-0144';
  assert.equal(readbackProblem(said(['user', '615 555 0144'], ['bot', 'So that\'s 6 1 5, 5 5 5, 0 1 4 4?']), phone, false), 'no_answer');
  assert.equal(readbackProblem(said(['bot', 'So that\'s six one five, five five five, oh one four four?'], ['user', 'Yes.']), phone, false), null);
  assert.equal(readbackProblem(said(['user', 'It\'s 615 555 0144'], ['bot', 'Got it.']), phone, false), 'no_readback');
  assert.equal(readbackProblem(said(['user', 'It\'s 615 555 0144']), phone, true), null, 'urgent jobs are never blocked for a missing read-back');
  assert.equal(readbackProblem(said(['bot', 'So that\'s 6 1 5 5 5 5 6 2 2, though?']), '6155556220', false), 'no_readback', 'a 9-digit read-back is not a read-back');
  assert.equal(readbackProblem(undefined, phone, false), null, 'no transcript on the payload: never blocks');
  assert.equal(readbackProblem(said(['user', 'hi']), '', false), null);
});

test('a save in the same turn as the read-back is refused twice at most, then goes through', async t => {
  const post = await fixture(t);
  const args = { ...details, address: '501 Woodland Street, Nashville', callback_phone: '615-555-0144' };
  const live = (id, turns) => ({ message: { ...payload(id, args).message, artifact: { messages: said(...turns) } } });
  const early = [['user', 'my number is 615 555 0144'], ['bot', 'So that\'s 6 1 5, 5 5 5, 0 1 4 4?']];
  const first = await post(live('rb', early));
  assert.equal(first.saved, false);
  assert.match(first.error, /wait for the caller to say yes/);
  assert.equal((await post(live('rb', [...early, ['user', 'yes that\'s right']]))).saved, true);
  const stuck = await post(live('rb2', early));
  assert.equal(stuck.saved, false);
  assert.equal((await post(live('rb2', early))).saved, false);
  assert.equal((await post(live('rb2', early))).saved, true, 'the third try saves so no caller is lost');
});
