import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from './server.mjs';
import { normalizeUsPhone, validateSignup, sha256 } from './trial.mjs';
import { form } from './fixtures/trial-form.mjs';

// Public trial signup, email verification, the status page, the waitlist and the admin dashboard.
// Every outbound request is recorded by the mocked send; nothing leaves the machine.
const key = 'synthetic-test-key-not-used-in-production';
const SITE = 'https://anchorlineappai.com';
const admin = 'admin-password-for-tests';
const env = { VAPI_WEBHOOK_SECRET: key, RESEND_API_KEY: 'fixture-only', EMAIL_FROM: 'hello@example.com', OFFICE_EMAIL: 'jake@example.com',
  PUBLIC_BASE_URL: 'https://receptionist.example', ADMIN_PASSWORD: admin, TRIAL_DRY_RUN: '1', TRIAL_POLL_MS: '0' };
async function fixture(t, extra = {}, dir = mkdtempSync(join(tmpdir(), 'trial-signup-'))) {
  const sent = [];
  const send = async (url, init) => { sent.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null }); return Response.json({}); };
  const app = createApp({ DATA_DIR: dir, ...env, ...extra }, send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  t.after(async () => { app.closeAllConnections(); if (app.listening) await new Promise(resolve => app.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const signup = (body, { origin = SITE, ip = '203.0.113.7' } = {}) => fetch(`${base}/trial/signup`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), 'x-forwarded-for': `10.0.0.1, ${ip}` }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const sql = (query, ...params) => { const db = new DatabaseSync(join(dir, 'requests.sqlite'));
    try { return /^\s*SELECT/i.test(query) ? db.prepare(query).all(...params).map(r => ({ ...r })) : db.prepare(query).run(...params); } finally { db.close(); } };
  const emails = () => sent.filter(s => s.url === 'https://api.resend.com/emails');
  const tokenFrom = mail => /verify\?token=([0-9a-f]{64})/.exec(mail.body.text)?.[1];
  const auth = (password = admin) => ({ authorization: `Basic ${Buffer.from(`jake:${password}`).toString('base64')}` });
  return { app, base, sent, signup, sql, emails, tokenFrom, auth, dir };
}

test('phone numbers are normalised to US E.164 and everything else is refused', () => {
  assert.equal(normalizeUsPhone('(615) 555-0142'), '+16155550142');
  assert.equal(normalizeUsPhone('+1 615.555.0142'), '+16155550142');
  assert.equal(normalizeUsPhone('16155550142'), '+16155550142');
  assert.equal(normalizeUsPhone('6155550142'), '+16155550142');
  assert.equal(normalizeUsPhone('+16155550142'), '+16155550142');
  for (const bad of ['555-0142', '0155550142', '6150550142', '6151550142', '1155550142', '+26155550142', '+1 (615) 555-014', '+44 20 7946 0958', '(115) 555-0142', '615-155-0142', 'call me', 6155550142, '615555014212'])
    assert.equal(normalizeUsPhone(bad), null, String(bad));
  const { value } = validateSignup(form());
  assert.deepEqual([value.owner_cell, value.shop_number, value.office_email, value.state], ['+17205550144', '+17205550155', 'office@obrien.example', 'CO']);
});

test('the website form sends phones as 10 plain digits; they are stored as E.164', async t => {
  const { signup, sql } = await fixture(t);
  assert.equal((await signup(form({ owner_cell: '6155550142', shop_number: '6155550143' }))).status, 202);
  assert.deepEqual(sql('SELECT owner_cell, shop_number FROM clients')[0], { owner_cell: '+16155550142', shop_number: '+16155550143' });
  for (const bad of ['0155550142', '6151550142', '615555014', '61555501420'])
    assert.deepEqual(await (await signup(form({ owner_cell: bad }))).json(), { error: 'Must be a US phone number', field: 'owner_cell' }, bad);
});

test('signup validation answers 400 with the failing field', async t => {
  const { signup, sql, emails } = await fixture(t);
  const cases = [
    [{ business: '' }, 'business'], [{ business: 'A'.repeat(101) }, 'business'], [{ business: '<script>alert(1)</script>' }, 'business'],
    [{ owner_name: undefined }, 'owner_name'], [{ owner_cell: '555-0144' }, 'owner_cell'], [{ shop_number: '+442079460958' }, 'shop_number'],
    [{ office_email: 'not-an-email' }, 'office_email'], [{ city: '' }, 'city'], [{ state: 'XX' }, 'state'], [{ services: '' }, 'services'],
    [{ services: 'x'.repeat(501) }, 'services'], [{ not_offered: 'x'.repeat(501) }, 'not_offered'], [{ emergency_rules: 7 }, 'emergency_rules'],
    [{ never_say: 'x'.repeat(501) }, 'never_say'], [{ hours: 'x'.repeat(201) }, 'hours'], [{ sms_consent: 'yes' }, 'sms_consent'],
    [{ terms_accepted: false }, 'terms_accepted'], [{ terms_accepted: 'true' }, 'terms_accepted'], [{ coupon: 'FREE' }, 'coupon']
  ];
  for (const [fields, field] of cases) {
    const response = await signup(form(fields));
    assert.equal(response.status, 400, field);
    const body = await response.json();
    assert.equal(body.field, field); assert.ok(body.error);
  }
  assert.equal((await signup('{"business":')).status, 400);
  assert.equal((await signup('[1,2]')).status, 400);
  assert.equal((await signup(JSON.stringify(form({ services: 'x'.repeat(40000) })))).status, 413);
  assert.equal(sql('SELECT COUNT(*) AS n FROM clients')[0].n, 0);
  assert.equal(emails().length, 0);
});

test('a valid signup stores the client, emails a hashed 24h verify link to the owner and tells Jake', async t => {
  const { signup, sql, emails, tokenFrom } = await fixture(t);
  const response = await signup(form());
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, status: 'pending_verification' });
  assert.equal(response.headers.get('access-control-allow-origin'), SITE);
  const [c] = sql('SELECT * FROM clients');
  assert.deepEqual([c.status, c.business, c.owner_cell, c.shop_number, c.state, c.city, c.signup_email, c.office_emails, c.sms_consent],
    ['pending_verification', "O'Brien & Sons Plumbing", '+17205550144', '+17205550155', 'CO', 'Denver', 'office@obrien.example', '["office@obrien.example"]', 1]);
  assert.equal(c.services, 'Drain cleaning, water heaters, repiping'); assert.equal(c.never_say, 'Never promise same-day service');
  assert.ok(c.terms_accepted_at);
  assert.equal(c.signup_ip_hash, sha256(`${key}|203.0.113.7`), 'the proxy-appended address, hashed');
  const [owner, office] = emails();
  assert.deepEqual(owner.body.to, ['office@obrien.example']);
  assert.equal(owner.body.from, 'Anchorline AI <hello@example.com>');
  assert.deepEqual(owner.body.reply_to, ['jake@example.com']);
  assert.match(owner.body.subject, /Confirm your email to set up Emma for O'Brien & Sons Plumbing/);
  const token = tokenFrom(owner);
  assert.match(owner.body.text, /https:\/\/receptionist\.example\/trial\/verify\?token=/);
  assert.equal(c.verify_token_hash, sha256(token));
  assert.ok(!JSON.stringify(sql('SELECT * FROM clients')).includes(token), 'the token itself is never stored');
  const expires = Date.parse(c.verify_token_expires_at) - Date.parse(c.created_at);
  assert.ok(Math.abs(expires - 86400000) < 5000);
  assert.deepEqual(office.body.to, ['jake@example.com']);
  assert.equal(office.body.subject, "New trial signup: O'Brien & Sons Plumbing");
  assert.match(office.body.text, /Services: Drain cleaning/); assert.match(office.body.text, /SMS consent: yes/);
});

test('a filled honeypot looks accepted but stores and sends nothing', async t => {
  const { signup, sql, emails } = await fixture(t);
  const response = await signup(form({ website: 'http://spam.example' }));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, status: 'pending_verification' });
  assert.equal(sql('SELECT COUNT(*) AS n FROM clients')[0].n, 0);
  assert.equal(emails().length, 0);
});

test('CORS allows only the website (and localhost in development), with a preflight', async t => {
  const { base, signup } = await fixture(t);
  const preflight = origin => fetch(`${base}/trial/signup`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  const ok = await preflight(SITE);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE);
  assert.match(ok.headers.get('access-control-allow-methods'), /POST/);
  assert.match(ok.headers.get('access-control-allow-headers'), /Content-Type/i);
  for (const origin of ['https://evil.example', 'http://anchorlineappai.com', 'https://anchorlineappai.com.evil.example', 'http://localhost:5173']) {
    const refused = await preflight(origin);
    assert.equal(refused.status, 403, origin);
    assert.equal(refused.headers.get('access-control-allow-origin'), null);
    assert.equal((await signup(form(), { origin })).status, 403, origin);
  }
  assert.equal((await signup(form(), { origin: null })).status, 403);
  assert.equal((await fetch(`${base}/trial/signup`, { headers: { origin: SITE } })).status, 405);
  const dev = await fixture(t, { APP_ENV: 'development' });
  assert.equal((await dev.signup(form(), { origin: 'http://localhost:5173' })).status, 202);
  assert.equal((await dev.signup(form({ office_email: 'b@x.example', shop_number: '7205550166' }), { origin: 'http://localhost.evil.example' })).status, 403);
});

test('signup is limited to 3 per IP per day and one open trial per office email or shop line', async t => {
  const { signup, sql } = await fixture(t);
  const shop = n => `720555${String(n).padStart(4, '0')}`;
  for (let i = 1; i <= 3; i++) assert.equal((await signup(form({ office_email: `o${i}@x.example`, shop_number: shop(1000 + i) }))).status, 202);
  const limited = await signup(form({ office_email: 'o4@x.example', shop_number: shop(1004) }));
  assert.equal(limited.status, 429);
  // Another network can still sign up, but not for an email or shop line that already has an open trial.
  const other = { ip: '198.51.100.9' };
  assert.equal((await signup(form({ office_email: 'O1@x.example', shop_number: shop(2000) }), other)).status, 409);
  assert.equal((await signup(form({ office_email: 'new@x.example', shop_number: '(720) 555-1001' }), other)).status, 409);
  // An unverified signup whose link expired no longer blocks a new one.
  sql("UPDATE clients SET verify_token_expires_at = '2000-01-01T00:00:00.000Z' WHERE signup_email = 'o2@x.example'");
  assert.equal((await signup(form({ office_email: 'o2@x.example', shop_number: shop(1002) }), other)).status, 202);
  // An ended trial does not block either.
  sql("UPDATE clients SET status = 'ended' WHERE signup_email = 'o3@x.example'");
  assert.equal((await signup(form({ office_email: 'o3@x.example', shop_number: shop(3000) }), other)).status, 202);
});

test('signup is refused with 503 until email and the public URL are configured', async t => {
  const { signup } = await fixture(t, { PUBLIC_BASE_URL: '' });
  assert.equal((await signup(form())).status, 503);
  const noMail = await fixture(t, { RESEND_API_KEY: '' });
  assert.equal((await noMail.signup(form())).status, 503);
});

test('verifying starts provisioning and shows a status page; the link works for 24 hours only', async t => {
  const { app, base, signup, sql, emails, tokenFrom } = await fixture(t);
  await signup(form());
  const token = tokenFrom(emails()[0]);
  const bad = await fetch(`${base}/trial/verify?token=${'0'.repeat(64)}`);
  assert.equal(bad.status, 400); assert.match(bad.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(`${base}/trial/verify?token=<script>`)).status, 400);
  const page = await fetch(`${base}/trial/verify?token=${token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const html = await page.text();
  assert.match(html, /<meta name="viewport"/);
  assert.doesNotMatch(html, /<script|<link |https?:\/\/(?!anchorlineappai)/, 'no external assets');
  assert.match(html, /O&#39;Brien &amp; Sons Plumbing/);
  const link = /href="(\/trial\/status\?c=[^"]+)"/.exec(html)[1].replace(/&amp;/g, '&');
  const [c] = sql('SELECT * FROM clients');
  assert.ok(c.verified_at); assert.equal(c.status_key_hash.length, 64);
  await app.trials.idle();
  const status = await (await fetch(`${base}${link}&format=json`)).json();
  assert.equal(status.status, 'active');
  assert.equal(status.business, "O'Brien & Sons Plumbing");
  assert.match(status.emma_number, /^\+1720555\d{4}$/);
  assert.equal(status.call_link, `tel:${status.emma_number}`);
  assert.equal(status.forwarding_link, `https://anchorlineappai.com/start/forwarding?n=${status.emma_number.slice(2)}`);
  assert.equal(status.days_left, 14); assert.equal(status.minutes_used, 0); assert.equal(status.minute_cap, 300); assert.equal(status.forwarding_confirmed, false);
  const statusHtml = await (await fetch(`${base}${link}`)).text();
  for (const part of ['Call Emma now', `href="tel:${status.emma_number}"`, 'start/forwarding?n=', 'Days left', '0 of 300', 'Forwarding confirmed'])
    assert.ok(statusHtml.includes(part), part);
  // Wrong or missing key: not found, and nothing about the client leaks.
  for (const q of [link.replace(/k=[0-9a-f]{4}/, 'k=0000'), `/trial/status?c=${c.id}`, '/trial/status?c=x&k=y']) {
    const r = await fetch(`${base}${q}&format=json`);
    assert.equal(r.status, 404); assert.doesNotMatch(await r.text(), /Brien/);
  }
  // Opening the verify link again within 24 hours gives a new status link; the old one stops working.
  const again = await (await fetch(`${base}/trial/verify?token=${token}`)).text();
  const newLink = /href="(\/trial\/status\?c=[^"]+)"/.exec(again)[1].replace(/&amp;/g, '&');
  assert.notEqual(newLink, link);
  assert.equal((await fetch(`${base}${link}`)).status, 404);
  assert.equal((await fetch(`${base}${newLink}`)).status, 200);
  // After 24 hours the link is dead.
  sql("UPDATE clients SET verify_token_expires_at = '2000-01-01T00:00:00.000Z'");
  assert.equal((await fetch(`${base}/trial/verify?token=${token}`)).status, 400);
});

test('when the active trials are full a signup is waitlisted until an admin approves it', async t => {
  const { base, signup, sql, emails, tokenFrom, auth } = await fixture(t, { TRIAL_MAX_ACTIVE: '1' });
  sql(`INSERT INTO clients (id, business, owner_name, owner_cell, shop_number, state, status, created_at)
    VALUES ('full', 'Busy Plumbing', 'Al', '+16155550400', '+16155550500', 'TN', 'active', '2026-10-01T00:00:00Z')`);
  const response = await signup(form());
  assert.deepEqual(await response.json(), { ok: true, status: 'waitlisted' });
  const [c] = sql("SELECT * FROM clients WHERE id <> 'full'");
  assert.equal(c.status, 'waitlisted'); assert.equal(c.verify_token_hash, null);
  const [owner, office] = emails();
  assert.match(owner.body.subject, /on the list/); assert.equal(tokenFrom(owner), undefined);
  assert.match(office.body.text, /Waitlisted: 1 of 1 trial slots in use/);
  // A second signup for the same shop while waitlisted is a duplicate.
  assert.equal((await signup(form(), { ip: '198.51.100.1' })).status, 409);
  const approve = await fetch(`${base}/admin/trials/${c.id}/approve`, { method: 'POST', headers: auth() });
  assert.equal(approve.status, 200);
  assert.equal((await approve.json()).status, 'pending_verification');
  assert.equal((await fetch(`${base}/admin/trials/${c.id}/approve`, { method: 'POST', headers: auth() })).status, 409);
  const verifyMail = emails().at(-1);
  assert.deepEqual(verifyMail.body.to, ['office@obrien.example']);
  assert.equal(sql(`SELECT verify_token_hash FROM clients WHERE id = '${c.id}'`)[0].verify_token_hash, sha256(tokenFrom(verifyMail)));
});

test('the admin dashboard needs ADMIN_PASSWORD over Basic auth', async t => {
  const unset = await fixture(t, { ADMIN_PASSWORD: '' });
  assert.equal((await fetch(`${unset.base}/admin/trials`, { headers: unset.auth('') })).status, 503);
  const { base, signup, sql, auth } = await fixture(t);
  await signup(form());
  const denied = await fetch(`${base}/admin/trials`);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate'), /^Basic/);
  assert.equal((await fetch(`${base}/admin/trials`, { headers: auth('wrong-password-123') })).status, 401);
  assert.equal((await fetch(`${base}/admin/trials`, { headers: { authorization: 'Bearer x' } })).status, 401);
  const ok = await fetch(`${base}/admin/trials`, { headers: auth() });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  for (const part of ['O&#39;Brien &amp; Sons Plumbing', 'pending_verification', 'Minutes', 'Job requests', 'Forwarding', 'Emma number', 'Errors']) assert.ok(html.includes(part), part);
  assert.doesNotMatch(html, /O'Brien & Sons/);
  const [c] = sql('SELECT id FROM clients');
  // Actions: POST only, same-site only, validated.
  assert.equal((await fetch(`${base}/admin/trials/${c.id}/end`, { headers: auth() })).status, 405);
  assert.equal((await fetch(`${base}/admin/trials/${c.id}/end`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/admin/trials/${c.id}/end`, { method: 'POST', headers: { ...auth(), origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/admin/trials/${c.id}/extend?days=7`, { method: 'POST', headers: auth() })).status, 409, 'not active yet');
  assert.equal((await fetch(`${base}/admin/trials/00000000-0000-0000-0000-000000000000/end`, { method: 'POST', headers: auth() })).status, 404);
  const ended = await fetch(`${base}/admin/trials/${c.id}/end`, { method: 'POST', headers: auth() });
  assert.deepEqual(await ended.json(), { ok: true, status: 'ended' });
  assert.equal(sql('SELECT status FROM clients')[0].status, 'ended');
  // Repeated wrong passwords from one address are locked out for a while.
  for (let i = 0; i < 10; i++) await fetch(`${base}/admin/trials`, { headers: auth(`guess-number-${i}`) });
  assert.equal((await fetch(`${base}/admin/trials`, { headers: auth() })).status, 429);
});

test('the step-1 clients table is upgraded in place and keeps its rows', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'trial-upgrade-'));
  const db = new DatabaseSync(join(dir, 'requests.sqlite'));
  db.exec(`CREATE TABLE clients (
    id TEXT PRIMARY KEY, assistant_id TEXT UNIQUE, phone_number_id TEXT, phone_number TEXT,
    business TEXT NOT NULL, owner_name TEXT NOT NULL, owner_cell TEXT NOT NULL,
    office_emails TEXT NOT NULL DEFAULT '[]', alert_call TEXT NOT NULL DEFAULT '[]', transfer TEXT, shop_number TEXT NOT NULL, state TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification', 'provisioning', 'active', 'ended')),
    trial_ends_at TEXT, minute_cap INTEGER NOT NULL DEFAULT 300, minutes_used REAL NOT NULL DEFAULT 0, cap_alerted_at TEXT,
    created_at TEXT NOT NULL, verified_at TEXT, verify_token_hash TEXT, verify_token_expires_at TEXT);
    CREATE TABLE client_calls (call_id TEXT PRIMARY KEY, client_id TEXT NOT NULL, minutes REAL NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO clients (id, assistant_id, business, owner_name, owner_cell, shop_number, state, status, minutes_used, created_at)
      VALUES ('old', 'asst-old', 'Old Plumbing', 'Al', '+16155550400', '+16155550500', 'TN', 'active', 12.5, '2026-10-15T00:00:00Z');
    INSERT INTO client_calls VALUES ('call-old', 'old', 12.5, '2026-10-15T00:00:00Z');`);
  db.close();
  const { sql } = await fixture(t, {}, dir);
  assert.deepEqual(sql('SELECT id, assistant_id, status, minutes_used, provision_attempts FROM clients'),
    [{ id: 'old', assistant_id: 'asst-old', status: 'active', minutes_used: 12.5, provision_attempts: 0 }]);
  assert.deepEqual(sql('SELECT call_id, is_test FROM client_calls'), [{ call_id: 'call-old', is_test: 0 }]);
  sql("UPDATE clients SET status = 'waitlisted'");
  assert.throws(() => sql("UPDATE clients SET status = 'trial'"), /CHECK/);
});
