import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp, garbledHouseNumber } from './server.mjs';

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
  for (const a of ['2 42 4 0 Elm Street', '1 2 3 Main St', '12345678 Oak Ave', '4-4-1 Pine Rd']) assert.equal(garbledHouseNumber(a), true, a);
  for (const a of ['24240 Elm Street', '100 200 Main St', '12-14 Main St', '742 Evergreen Terrace', 'Not given', '', 'Route 9, Lebanon', '5 Oak Ct', '3rd Ave N'])
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
