import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from './server.mjs';

test('authenticated tool calls persist, deduplicate and never email unconfirmed addresses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchorline-test-'));
  const env = { DATA_DIR: dir, VAPI_WEBHOOK_SECRET: 'test-only-secret-not-for-production-123' };
  let app;
  async function start() { app = createApp(env); app.listen(0, '127.0.0.1'); await once(app, 'listening'); return `http://127.0.0.1:${app.address().port}`; }
  async function stop() { await new Promise(resolve => app.close(resolve)); }
  let url = await start();
  const args = { name: 'Test Person', address: 'Fictional test address', issue: 'Synthetic verification', is_test: true, email: 'do-not-send@example.com', email_confirmed: false };
  const payload = (id, parameters = args) => ({ message: { type: 'tool-calls', call: { id }, toolCallList: [{ id: 'tool-test', function: { name: 'submit_service_request', arguments: JSON.stringify(parameters) } }] } });
  const post = async (body, key = env.VAPI_WEBHOOK_SECRET) => fetch(url + '/vapi/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url + '/readyz')).status, 200);
    assert.equal((await post(payload('call-a'), 'wrong')).status, 401);
    const first = JSON.parse((await (await post(payload('call-a'))).json()).results[0].result);
    assert.equal(first.saved, true); assert.equal(first.caller_email, 'not_requested');
    const duplicate = JSON.parse((await (await post(payload('call-a'))).json()).results[0].result);
    assert.equal(first.request_id, duplicate.request_id); assert.equal(duplicate.duplicate, true);
    const invalid = JSON.parse((await (await post(payload('call-b', { ...args, email_confirmed: true, email: 'bad' }))).json()).results[0].result);
    assert.equal(invalid.saved, false);
    await stop(); url = await start();
    const restarted = JSON.parse((await (await post(payload('call-a'))).json()).results[0].result);
    assert.equal(first.request_id, restarted.request_id);
    const batch = payload('call-c'); batch.message.toolCallList = [{ id: 'new-format', name: 'submit_service_request', parameters: args }];
    const result = await (await post(batch)).json(); assert.equal(result.results[0].toolCallId, 'new-format'); assert.equal(JSON.parse(result.results[0].result).saved, true);
  } finally { await stop(); rmSync(dir, { recursive: true }); }
});

test('unconfigured backend stays healthy but rejects intake', async () => {
  const app = createApp({}); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(url + '/healthz')).status, 200);
    assert.equal((await fetch(url + '/readyz')).status, 503);
    assert.equal((await fetch(url + '/vapi/webhook', { method: 'POST' })).status, 503);
  } finally { await new Promise(resolve => app.close(resolve)); }
});
