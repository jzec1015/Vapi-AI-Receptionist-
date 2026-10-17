import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createApp } from './server.mjs';
import { createApp as createV150 } from './fixtures/server-v1.5.0.mjs';

// The production volume holds /data/requests.sqlite written by v1.5.0 (main 6e0be10). These tests run the
// real v1.5.0 code against a database, then the new code on the same file, and back again (a Railway rollback).
const key = 'synthetic-test-key-not-used-in-production';
const emma = 'assistant-emma';
const routes = JSON.stringify({ [emma]: { business: 'Gold Star Plumbing', email: ['owner@example.com'], call: ['+15550000999'] } });
const env = { VAPI_WEBHOOK_SECRET: key, ALERT_ROUTES: routes, RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'alerts@example.com',
  VAPI_API_KEY: 'fixture-only', ALERT_CALL_FROM_ID: 'from-line' };
const intake = { name: 'Synthetic Caller', address: '1 Fixture Lane', issue: 'Running toilet', is_test: false, callback_phone: '5550001234',
  email: 'caller@example.com', email_confirmed: true, email_status: 'confirmed' };
const toolCall = (id, name, args, call = { id, assistantId: emma, customer: { number: '+15550001111' } }) =>
  ({ message: { type: 'tool-calls', call, toolCallList: [{ id: 'tool-1', function: { name, arguments: args } }] } });
const chatCall = (sessionId, args) => ({ message: { type: 'tool-calls', chat: { id: 'turn', sessionId, assistantId: emma },
  toolCallList: [{ id: 'tool-1', function: { name: 'submit_service_request', arguments: args } }] } });
const hangup = (id, summary) => ({ message: { type: 'end-of-call-report', durationSeconds: 40, summary,
  call: { id, assistantId: emma, customer: { number: '+15550002222' } } } });

async function start(t, factory, dir) {
  const sent = [];
  const send = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  const app = factory({ DATA_DIR: dir, ...env }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = async body => fetch(base + '/vapi/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchorline-key': key }, body: JSON.stringify(body) });
  const close = async () => { app.closeAllConnections(); if (app.listening) await new Promise(resolve => app.close(resolve)); };
  t.after(close);
  return { base, post, sent, close };
}
const result = async response => JSON.parse((await response.json()).results[0].result);
const rows = dir => { const db = new DatabaseSync(join(dir, 'requests.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT call_id, assistant_id, is_test FROM requests ORDER BY call_id').all().map(r => [r.call_id, r.assistant_id, r.is_test]); }
  finally { db.close(); } };

async function v150Database(t) {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = await start(t, createV150, dir);
  assert.equal((await result(await old.post(toolCall('old-live', 'submit_service_request', intake)))).saved, true);
  assert.equal((await result(await old.post(toolCall('old-test', 'submit_service_request', { ...intake, is_test: true })))).saved, true);
  assert.equal((await result(await old.post(toolCall('old-late', 'submit_service_request',
    { ...intake, issue: 'URGENT - burst pipe', email: undefined, email_confirmed: false, email_status: 'skipped_emergency' })))).saved, true);
  assert.equal((await result(await old.post(chatCall('old-chat', intake)))).saved, true);
  assert.equal((await old.post(hangup('old-hangup', 'Caller asked about a leak'))).status, 200);
  await old.close();
  return dir;
}

test('the new server starts on a database written by v1.5.0 and keeps every row usable', async t => {
  const dir = await v150Database(t);
  const app = await start(t, createApp, dir);
  const health = await (await fetch(app.base + '/healthz')).json();
  assert.equal(health.status, 'ok'); assert.equal(health.ready, true); assert.equal(health.storage_configured, true);
  // v1.5.0 did not store the assistant; chat sessions are tests in v1.6 (Emma takes live jobs by phone only).
  assert.deepEqual(rows(dir), [['old-hangup', null, 0], ['old-late', null, 0], ['old-live', null, 0], ['old-test', null, 1], ['session:old-chat', null, 1]]);
  // Vapi retries of an old call stay duplicates; a late email and a note on an old row still work.
  assert.equal((await result(await app.post(toolCall('old-live', 'submit_service_request', intake)))).duplicate, true);
  const late = await result(await app.post(toolCall('old-late', 'add_customer_email', { email: 'late@example.com', confirmed_after_spelling_back: true })));
  assert.equal(late.email_added, true); assert.equal(late.caller_email, 'accepted');
  assert.equal((await result(await app.post(toolCall('old-late', 'add_request_note', { note: 'Gate code 1234' })))).office_alert, 'sent');
  // A hang-up report for an already saved old call is not saved twice.
  const before = app.sent.length;
  await app.post(hangup('old-hangup', 'again'));
  assert.equal(app.sent.length, before);
  // New rows carry the assistant and the test flag.
  await app.post(toolCall('new-live', 'submit_service_request', intake));
  await app.post(toolCall('new-test', 'submit_service_request', { ...intake, is_test: true }));
  assert.deepEqual(rows(dir).filter(r => r[0].startsWith('new')), [['new-live', emma, 0], ['new-test', emma, 1]]);
  const summary = await (await fetch(app.base + '/admin/requests/summary', { headers: { 'x-anchorline-key': key } })).json();
  assert.deepEqual([summary.total, summary.live, summary.test], [7, 4, 3]);
});

test('a damaged row does not stop the server from starting', async t => {
  const dir = await v150Database(t);
  const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?, ?)').run('chat:broken', 'id-x', '2026-10-01T00:00:00Z', 'not json', '{}');
  db.close();
  const app = await start(t, createApp, dir);
  assert.equal((await (await fetch(app.base + '/healthz')).json()).ready, true);
  assert.deepEqual(rows(dir).find(r => r[0] === 'chat:broken'), ['chat:broken', null, 0]);
  assert.equal((await (await fetch(app.base + '/admin/requests/summary', { headers: { 'x-anchorline-key': key } })).json()).total, 6);
});

test('startup waits for a briefly locked database instead of crashing', async t => {
  const dir = await v150Database(t);
  // Another process (e.g. an ops script) holds the write lock for half a second while the server starts.
  const holder = spawn(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); db.exec('COMMIT');`, join(dir, 'requests.sqlite')], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(holder, 'exit');
  await once(holder.stdout, 'data');
  const app = await start(t, createApp, dir);
  assert.equal((await (await fetch(app.base + '/healthz')).json()).ready, true);
  await exited;
});

test('restarting on an already migrated database changes nothing', async t => {
  const dir = await v150Database(t);
  const first = await start(t, createApp, dir);
  await first.post(toolCall('new-1', 'submit_service_request', intake));
  const once1 = rows(dir);
  await first.close();
  const second = await start(t, createApp, dir);
  assert.deepEqual(rows(dir), once1);
  assert.equal((await (await fetch(second.base + '/healthz')).json()).ready, true);
});

test('rolling back to v1.5.0 after v1.6 ran still saves requests and hang-ups', async t => {
  const dir = await v150Database(t);
  const app = await start(t, createApp, dir);
  await app.post(toolCall('new-1', 'submit_service_request', intake));
  await app.close();
  const old = await start(t, createV150, dir);
  const saved = await result(await old.post(toolCall('after-rollback', 'submit_service_request', intake)));
  assert.equal(saved.saved, true, JSON.stringify(saved));
  await old.post(hangup('after-rollback-hangup', 'Caller asked about a leak'));
  assert.equal((await result(await old.post(toolCall('new-1', 'submit_service_request', intake)))).duplicate, true);
  await old.close();
  // And forward again: rows the rollback wrote are read correctly.
  await start(t, createApp, dir);
  assert.deepEqual(rows(dir).filter(r => r[0].startsWith('after')), [['after-rollback', null, 0], ['after-rollback-hangup', null, 0]]);
});

// note-fail-line: tool_failures (the loop guard for failed add_request_note / add_customer_email calls) is a new table only.
const noteCall = (id, toolId, text) => ({ message: { type: 'tool-calls', call: { id, assistantId: emma },
  toolCallList: [{ id: toolId, function: { name: 'add_request_note', arguments: { note: text } } }] } });
const failureColumns = dir => { const db = new DatabaseSync(join(dir, 'requests.sqlite'), { readOnly: true });
  try { return db.prepare('PRAGMA table_info(tool_failures)').all().map(c => c.name); } finally { db.close(); } };
const kindOf = r => !r.note ? `saved=${r.saved}` : r.note.includes('Do not call') ? 'STOP' : 'RETRY';

test('a v1.5.0 database without tool_failures gets the table, and rollback to v1.5.0 and forward again stay safe', async t => {
  const dir = await v150Database(t);
  assert.deepEqual(failureColumns(dir), []);
  const app = await start(t, createApp, dir);
  assert.equal((await (await fetch(app.base + '/healthz')).json()).ready, true);
  assert.deepEqual(failureColumns(dir), ['call_id', 'name', 'tool_call_id', 'failures', 'cleared', 'updated_at']);
  // Old rows still work, and the guard counts on the upgraded file.
  assert.equal(kindOf(await result(await app.post(noteCall('old-live', 'n1', '')))), 'RETRY');
  assert.equal(kindOf(await result(await app.post(noteCall('old-live', 'n2', '')))), 'STOP');
  await app.close();
  // Rollback: v1.5.0 ignores the table, saves requests and notes, and returns its own saved:false results.
  const old = await start(t, createV150, dir);
  assert.equal((await result(await old.post(toolCall('after-rollback', 'submit_service_request', intake)))).saved, true);
  assert.equal((await result(await old.post(noteCall('after-rollback', 'o1', 'Gate 5')))).saved, true);
  const oldFail = await result(await old.post(noteCall('after-rollback', 'o2', '')));
  assert.equal(oldFail.saved, false); assert.equal(oldFail.note, undefined);
  await old.close();
  // Forward again: the table and its counts are as they were; rows v1.5.0 wrote are usable.
  const again = await start(t, createApp, dir);
  assert.deepEqual(failureColumns(dir), ['call_id', 'name', 'tool_call_id', 'failures', 'cleared', 'updated_at']);
  assert.equal(kindOf(await result(await again.post(noteCall('old-live', 'n3', '')))), 'STOP');
  assert.equal(kindOf(await result(await again.post(noteCall('old-live', 'n4', 'Gate 6')))), 'saved=true');
  assert.equal(kindOf(await result(await again.post(noteCall('old-live', 'n5', '')))), 'RETRY');
  assert.equal(kindOf(await result(await again.post(noteCall('after-rollback', 'n1', '')))), 'RETRY');
  assert.deepEqual(rows(dir).filter(r => r[0].startsWith('after')), [['after-rollback', null, 0]]);
});

test('the unreleased one-row-per-tool tool_failures (6d7a92b) is replaced on startup', async t => {
  const dir = await v150Database(t);
  const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  db.exec(`CREATE TABLE tool_failures (call_id TEXT NOT NULL, name TEXT NOT NULL, failures INTEGER NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (call_id, name)); INSERT INTO tool_failures VALUES ('old-live', 'add_request_note', 7, '2026-10-17T00:00:00Z');`);
  db.close();
  const app = await start(t, createApp, dir);
  assert.equal((await (await fetch(app.base + '/healthz')).json()).ready, true);
  assert.deepEqual(failureColumns(dir), ['call_id', 'name', 'tool_call_id', 'failures', 'cleared', 'updated_at']);
  assert.equal(kindOf(await result(await app.post(noteCall('old-live', 'n1', '')))), 'RETRY');
  await app.close();
  // A second start on the new shape changes nothing.
  const again = await start(t, createApp, dir);
  assert.equal(kindOf(await result(await again.post(noteCall('old-live', 'n2', '')))), 'STOP');
});
