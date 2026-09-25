import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp, conversationKey } from './server.mjs';

const key = 'synthetic-test-key-not-used-in-production';
const details = { name: 'Synthetic Test', address: 'Test fixture only', issue: 'Synthetic verification', is_test: true };
const payload = (id, args = details) => ({ message: { type: 'tool-calls', call: { id }, toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } });
async function fixture(t, extra = {}, send = async () => { throw new Error('Unexpected outbound request'); }) {
  const dir = mkdtempSync(join(tmpdir(), 'receptionist-test-'));
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, ...extra }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${app.address().port}/vapi/webhook`;
  return async body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
const result = async response => JSON.parse((await response.json()).results[0].result);

test('concurrent delivery returns one durable request identity', async t => {
  const post = await fixture(t);
  const values = await Promise.all(Array.from({ length: 12 }, async () => result(await post(payload('concurrent-call')))));
  assert.ok(values.every(v => v.saved));
  assert.equal(new Set(values.map(v => v.request_id)).size, 1);
});

test('Vapi alternate envelope returns a correlated result and suppresses test receipts', async t => {
  const post = await fixture(t, { OFFICE_EMAIL: 'office@example.com', EMAIL_FROM: 'test@example.com', RESEND_API_KEY: 'fixture-only' });
  const response = await post({ message: { type: 'tool-calls', call: { id: 'alternate' }, toolWithToolCallList: [{ name: 'submit_service_request', toolCall: { id: 'alternate-tool', parameters: { ...details, email: 'test@example.com', email_confirmed: true } } }] } });
  const body = await response.json();
  assert.equal(body.results[0].toolCallId, 'alternate-tool');
  const value = JSON.parse(body.results[0].result);
  assert.equal(value.saved, true);
  assert.equal(value.caller_email, 'suppressed_test');
  assert.equal(value.anchorline_email, 'suppressed_test');
});

test('invalid JSON, oversized requests and malformed tool lists are rejected', async t => {
  const post = await fixture(t);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(' '.repeat(262145))).status, 413);
  for (const list of [[], {}, [{ id: '' }]]) {
    assert.equal((await post({ message: { type: 'tool-calls', toolCallList: list } })).status, 400);
  }
  assert.equal((await post({ message: { type: 'tool-calls', toolWithToolCallList: {} } })).status, 400);
});

test('missing call identity, wrong tool and invalid intake never report a save', async t => {
  const post = await fixture(t);
  assert.equal((await result(await post(payload('')))).saved, false);
  const wrong = payload('wrong-tool'); wrong.message.toolCallList[0].function.name = 'book_appointment';
  assert.equal((await result(await post(wrong))).saved, false);
  assert.equal((await result(await post(payload('invalid', { ...details, name: '' })))).saved, false);
});

test('email provider failure preserves the request and does not resend on retry', async t => {
  let sends = 0;
  const post = await fixture(t, { RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'test@example.com' }, async () => { sends++; return new Response('{}', { status: 503 }); });
  const request = payload('mail-failure', { ...details, is_test: false, email: 'test@example.com', email_confirmed: true });
  const first = await result(await post(request));
  assert.equal(first.saved, true); assert.equal(first.caller_email, 'needs_review');
  const retry = await result(await post(request));
  assert.equal(retry.request_id, first.request_id); assert.equal(sends, 1);
});

test('conversation identity preserves voice keys and rejects malformed identifiers', () => {
  assert.equal(conversationKey({ call: { id: 'voice-id' } }), 'voice-id');
  assert.equal(conversationKey({ call: { id: '' }, chat: { id: 'chat-id' } }), null);
  assert.equal(conversationKey({ chat: { id: 'x'.repeat(201) } }), null);
  assert.equal(conversationKey({ session: { id: 'session-id' }, chat: { id: 'turn-id' } }), 'session:session-id');
  assert.equal(conversationKey({ chat: { id: 'turn-id', sessionId: 'session-id' } }), 'session:session-id');
});

test('dashboard chat intake saves and deduplicates separately from phone calls', async t => {
  const post = await fixture(t);
  const chat = payload('same-id'); delete chat.message.call; chat.message.chat = { id: 'same-id' };
  const first = await result(await post(chat));
  assert.equal(first.saved, true);
  assert.equal((await result(await post(chat))).request_id, first.request_id);
  const voice = await result(await post(payload('same-id')));
  assert.notEqual(voice.request_id, first.request_id);
});

test('successive chat turns in one session cannot duplicate an intake', async t => {
  const post = await fixture(t);
  const chat = payload('unused'); delete chat.message.call;
  chat.message.chat = { id: 'turn-1', sessionId: 'session-1' };
  const first = await result(await post(chat));
  chat.message.chat.id = 'turn-2';
  const second = await result(await post(chat));
  assert.equal(second.request_id, first.request_id);
  assert.equal(second.duplicate, true);
});
