import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createBooking, openWindows, zonedToUtc, windowLabel } from './booking.mjs';
import { createApp } from './server.mjs';

// Monday 2026-10-19 06:00 in Nashville (CDT, UTC-5). Windows that day: 13-16Z, 16-19Z, 19-22Z.
const NOW = Date.parse('2026-10-19T11:00:00Z');
const TZ = 'America/Chicago';
const TECHS = ['t1', 't2', 't3', 't4'];
const base = { timezone: TZ, technicianIds: TECHS, daysAhead: 1, reserveTrucks: 1, leadMinutes: 120 };
const W1 = '2026-10-19T13:00:00.000Z', W2 = '2026-10-19T16:00:00.000Z', W3 = '2026-10-19T19:00:00.000Z';
const job = (techId, start, end) => ({ techId, start, end });
const request = { request_id: 'req-1', name: 'Linda Harper', address: '48 Birch Road, Nashville TN 37211', issue: 'Water heater leaking at the base',
  callback_phone: '6155550142', caller_id: '+16155550100', email: 'linda@example.com', job_type: 'Water heater replacement', job_size: 'Big job (half day+)', is_test: false };

// Mocked HTTP: [regex on "METHOD url", handler(url, init) -> body | {status, body}]. Unmatched calls fail loudly.
function mockHttp(routes) {
  const calls = [];
  const send = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body && /json/.test(init.headers?.['Content-Type'] || '') ? JSON.parse(init.body) : init.body;
    calls.push({ method, url, headers: init.headers || {}, body });
    for (const [pattern, handler] of routes) if (pattern.test(`${method} ${url}`)) {
      const r = await handler(url, { ...init, body });
      const status = r?.__status ?? 200;
      return new Response(JSON.stringify(r?.__status ? r.body : r), { status });
    }
    return new Response('{"error":"unmocked"}', { status: 599 });
  };
  return { send, calls, hit: re => calls.filter(c => re.test(`${c.method} ${c.url}`)) };
}
const routesEnv = (cfg, extra = {}) => ({ BOOKING_ROUTES: JSON.stringify({ 'gold-star': cfg }), ...extra });
const ctx = (over = {}) => ({ callId: 'call-1', assistantId: 'gold-star', request, ...over });

// ---------- capacity logic ----------
test('windows need a free truck beyond the emergency reserve', () => {
  const busy = [job('t1', W1, '2026-10-19T14:00:00Z'), job('t2', W1, W2), job('t3', '2026-10-19T15:30:00Z', '2026-10-19T17:00:00Z'), // W1: 3 busy -> 1 free = reserve only
    job('t1', W2, W3)]; // W2: t1 + t3 busy -> 2 free -> capacity 1
  const open = openWindows(base, TECHS, busy, NOW);
  assert.deepEqual(open.map(w => w.window_id), [W2, W3]);
  assert.deepEqual(open[0].freeTechs, ['t2', 't4']);
  assert.equal(open[0].label, 'Monday, October 19, between 11 AM and 2 PM');
});

test('scheduled work with no tech assigned still takes a truck', () => {
  const busy = [job(null, W3, '2026-10-19T20:00:00Z'), job(null, W3, '2026-10-19T20:00:00Z'), job('t1', W3, '2026-10-19T22:00:00Z')];
  assert.ok(!openWindows(base, TECHS, busy, NOW).some(w => w.window_id === W3));
});

test('lead time, weekends and DST are respected', () => {
  const late = openWindows(base, TECHS, [], Date.parse('2026-10-19T14:30:00Z')); // 9:30 local: 11am window is < 2h away
  assert.deepEqual(late.map(w => w.window_id), [W3]);
  const saturday = openWindows({ ...base, daysAhead: 2 }, TECHS, [], Date.parse('2026-10-24T11:00:00Z'));
  assert.equal(saturday.length, 0);
  assert.equal(zonedToUtc('2026-11-02', '08:00', TZ).toISOString(), '2026-11-02T14:00:00.000Z'); // CST after DST ends
  assert.equal(windowLabel(new Date(W1), new Date(W2), TZ), 'Monday, October 19, between 8 and 11 AM');
});

// ---------- Housecall Pro ----------
function hcpMock(jobs = () => []) {
  return mockHttp([
    [/GET https:\/\/api\.housecallpro\.com\/jobs\?.*page=1&/, () => ({ jobs: jobs().slice(0, 1), total_pages: 2 })],
    [/GET https:\/\/api\.housecallpro\.com\/jobs\?.*page=2&/, () => ({ jobs: jobs().slice(1), total_pages: 2 })],
    [/GET https:\/\/api\.housecallpro\.com\/customers\?/, () => ({ customers: [] })],
    [/POST https:\/\/api\.housecallpro\.com\/customers$/, () => ({ id: 'cus_1', addresses: [{ id: 'adr_1' }] })],
    [/POST https:\/\/api\.housecallpro\.com\/leads$/, () => ({ id: 'lead_1' })],
    [/POST https:\/\/api\.housecallpro\.com\/jobs$/, () => ({ id: 'job_1' })]
  ]);
}
const hcpJob = (id, start, end, techs) => ({ id, work_status: 'scheduled', schedule: { scheduled_start: start, scheduled_end: end }, assigned_employees: techs.map(t => ({ id: t })) });

test('HCP: availability comes only from the live, paginated schedule, with API-key auth', async () => {
  const http = hcpMock(() => [hcpJob('a', W1, W2, ['t1', 't2']), hcpJob('b', W1, W2, ['t3']), { ...hcpJob('c', W2, W3, ['t1', 't2', 't3']), work_status: 'user canceled' }]);
  const b = createBooking(routesEnv({ ...base, provider: 'housecallpro' }, { HCP_API_KEY: 'hcp-test' }), http.send, new Map(), { now: () => NOW });
  const r = await b.handle('check_availability', ctx(), {});
  assert.equal(r.ok, true); assert.equal(r.mode, 'request');
  assert.deepEqual(r.windows.map(w => w.window_id), [W2, W3]); // W1 full; canceled job ignored
  assert.equal(http.hit(/GET .*\/jobs\?/).length, 2);
  assert.equal(http.calls[0].headers.Authorization, 'Token hcp-test');
});

test('HCP request mode: creates customer + lead, never claims a confirmed appointment', async () => {
  const http = hcpMock();
  const b = createBooking(routesEnv({ ...base, provider: 'housecallpro' }), http.send, new Map(), { now: () => NOW });
  const r = await b.handle('book_window', ctx(), { window_id: W2, caller_agreed: true });
  assert.equal(r.booked, true); assert.equal(r.appointment_confirmed, false); assert.equal(r.status, 'pending_office_confirmation');
  const [cust] = http.hit(/POST .*\/customers$/);
  assert.equal(cust.body.first_name, 'Linda'); assert.equal(cust.body.mobile_number, '6155550142');
  const [lead] = http.hit(/POST .*\/leads$/);
  assert.match(lead.body.note, /NOT CONFIRMED/); assert.equal(http.hit(/POST .*\/jobs$/).length, 0);
});

test('HCP book mode: schedules on a free tech, then is idempotent per call', async () => {
  const http = hcpMock(() => [hcpJob('a', W2, W3, ['t1'])]);
  const store = new Map();
  const b = createBooking(routesEnv({ ...base, provider: 'housecallpro', mode: 'book' }), http.send, store, { now: () => NOW });
  const r = await b.handle('book_window', ctx(), { window_id: W2, caller_agreed: true });
  assert.equal(r.appointment_confirmed, true); assert.equal(r.status, 'scheduled'); assert.equal(r.external_id, 'job_1');
  const [posted] = http.hit(/POST .*\/jobs$/);
  assert.deepEqual(posted.body.assigned_employee_ids, ['t2']);
  assert.deepEqual(posted.body.schedule, { scheduled_start: W2, scheduled_end: W3, arrival_window: 0 });
  const again = await b.handle('book_window', ctx(), { window_id: W2, caller_agreed: true });
  assert.equal(again.duplicate, true); assert.equal(http.hit(/POST .*\/jobs$/).length, 1);
});

test('HCP book mode: a window filled since it was offered is refused with alternatives', async () => {
  let jobs = [];
  const http = hcpMock(() => jobs);
  const b = createBooking(routesEnv({ ...base, provider: 'housecallpro', mode: 'book' }), http.send, new Map(), { now: () => NOW });
  assert.ok((await b.handle('check_availability', ctx(), {})).windows.some(w => w.window_id === W1));
  jobs = [hcpJob('x', W1, W2, ['t1', 't2', 't3'])]; // office booked 3 trucks meanwhile
  const r = await b.handle('book_window', ctx(), { window_id: W1, caller_agreed: true });
  assert.equal(r.booked, false); assert.equal(r.status, 'window_taken'); assert.equal(r.appointment_confirmed, false);
  assert.deepEqual(r.alternatives.map(w => w.window_id), [W2, W3]);
  assert.equal(http.hit(/POST/).length, 0);
});

test('two callers racing for the last truck: only one gets it', async () => {
  const jobs = [hcpJob('a', W1, W2, ['t1', 't2'])]; // W1 capacity = 4 - 2 - reserve 1 = 1
  const routes = [
    [/GET .*\/jobs\?.*page=1&/, () => ({ jobs: [...jobs], total_pages: 1 })],
    [/GET .*\/customers\?/, () => ({ customers: [] })],
    [/POST .*\/customers$/, () => ({ id: 'cus', addresses: [{ id: 'adr' }] })],
    [/POST .*\/jobs$/, async (url, init) => { await new Promise(r => setTimeout(r, 20)); jobs.push(hcpJob('new', W1, W2, init.body.assigned_employee_ids)); return { id: `job_${jobs.length}` }; }]
  ];
  const http = mockHttp(routes);
  const b = createBooking(routesEnv({ ...base, provider: 'housecallpro', mode: 'book' }), http.send, new Map(), { now: () => NOW });
  const [a, c] = await Promise.all([
    b.handle('book_window', ctx({ callId: 'A' }), { window_id: W1, caller_agreed: true }),
    b.handle('book_window', ctx({ callId: 'B' }), { window_id: W1, caller_agreed: true })]);
  assert.deepEqual([a.status, c.status].sort(), ['scheduled', 'window_taken']);
  assert.equal(http.hit(/POST .*\/jobs$/).length, 1);
});

test('guards: urgent, test calls, unsaved requests, no caller yes, provider outage, unconfigured line', async () => {
  const http = hcpMock();
  const b = createBooking(routesEnv({ ...base, provider: 'housecallpro', mode: 'book' }), http.send, new Map(), { now: () => NOW });
  const urgent = ctx({ request: { ...request, issue: 'URGENT - pipe burst, water everywhere' } });
  assert.equal((await b.handle('check_availability', urgent, {})).reason, 'urgent');
  assert.equal((await b.handle('book_window', urgent, { window_id: W2, caller_agreed: true })).booked, false);
  assert.equal((await b.handle('book_window', ctx({ request: { ...request, is_test: true } }), { window_id: W2, caller_agreed: true })).status, 'suppressed_test');
  assert.match((await b.handle('book_window', ctx({ request: null }), { window_id: W2, caller_agreed: true })).error, /Save the request first/);
  assert.match((await b.handle('book_window', ctx(), { window_id: W2 })).error, /clear yes/);
  assert.equal(http.hit(/POST/).length, 0);
  const down = createBooking(routesEnv({ ...base, provider: 'housecallpro', mode: 'book' }), async () => new Response('busy', { status: 503 }), new Map(), { now: () => NOW });
  assert.equal((await down.handle('check_availability', ctx(), {})).ok, false);
  const failed = await down.handle('book_window', ctx(), { window_id: W2, caller_agreed: true });
  assert.equal(failed.booked, false); assert.equal(failed.appointment_confirmed, false);
  const none = createBooking({}, http.send);
  assert.equal((await none.handle('check_availability', ctx(), {})).reason, 'not_available');
});

// ---------- Jobber ----------
test('Jobber: rotating OAuth refresh, versioned GraphQL, visits -> windows, requestCreate', async () => {
  const saved = [];
  const http = mockHttp([
    [/POST https:\/\/api\.getjobber\.com\/api\/oauth\/token/, () => ({ access_token: 'jb-access', refresh_token: 'jb-refresh-2', expires_in: 3600 })],
    [/POST https:\/\/api\.getjobber\.com\/api\/graphql/, (url, init) => {
      const q = init.body.query;
      if (q.includes('visits')) return { data: { visits: { nodes: [
        { startAt: W1, endAt: W2, visitStatus: 'UPCOMING', assignedUsers: { nodes: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] } }],
        pageInfo: { hasNextPage: false, endCursor: null } } } };
      if (q.includes('clientCreate')) return { data: { clientCreate: { client: { id: 'client-1' }, userErrors: [] } } };
      if (q.includes('requestCreate(')) return { data: { requestCreate: { request: { id: 'req-jb-1' }, userErrors: [] } } };
      return { data: { requestCreateNote: { userErrors: [] } } };
    }]
  ]);
  const env = routesEnv({ ...base, provider: 'jobber', apiVersion: '2025-01-20' }, { JOBBER_REFRESH_TOKEN: 'jb-refresh-1', JOBBER_CLIENT_ID: 'id', JOBBER_CLIENT_SECRET: 'secret' });
  const b = createBooking(env, http.send, new Map(), { now: () => NOW, hooks: { saveRefreshToken: (p, t) => saved.push([p, t]) } });
  const r = await b.handle('check_availability', ctx(), {});
  assert.deepEqual(r.windows.map(w => w.window_id), [W2, W3]);
  const [tok] = http.hit(/oauth\/token/);
  assert.match(tok.body, /grant_type=refresh_token&refresh_token=jb-refresh-1/);
  assert.deepEqual(saved, [['jobber', 'jb-refresh-2']]);
  const gql = http.hit(/graphql/)[0];
  assert.equal(gql.headers.Authorization, 'Bearer jb-access'); assert.equal(gql.headers['X-JOBBER-GRAPHQL-VERSION'], '2025-01-20');
  const booked = await b.handle('book_window', ctx(), { window_id: W2, caller_agreed: true });
  assert.equal(booked.kind, 'request'); assert.equal(booked.appointment_confirmed, false);
  const create = http.hit(/graphql/).find(c => c.body.query.includes('clientCreate'));
  assert.deepEqual(create.body.variables.input.phones, [{ number: '6155550142', primary: true }]);
  assert.equal(http.hit(/oauth\/token/).length, 1); // token cached
});

test('Jobber: userErrors are failures, not bookings', async () => {
  const http = mockHttp([
    [/oauth\/token/, () => ({ access_token: 'a', expires_in: 3600 })],
    [/graphql/, (url, init) => init.body.query.includes('visits')
      ? { data: { visits: { nodes: [], pageInfo: { hasNextPage: false } } } }
      : { data: { clientCreate: { client: null, userErrors: [{ message: 'Phone is invalid' }] } } }]
  ]);
  const b = createBooking(routesEnv({ ...base, provider: 'jobber' }), http.send, new Map(), { now: () => NOW });
  const r = await b.handle('book_window', ctx(), { window_id: W2, caller_agreed: true });
  assert.equal(r.booked, false); assert.equal(r.status, 'error');
});

// ---------- ServiceTitan ----------
test('ServiceTitan: client-credentials + ST-App-Key, capacity API with reserve, booking into the CSR inbox', async () => {
  const http = mockHttp([
    [/POST https:\/\/auth-integration\.servicetitan\.io\/connect\/token/, () => ({ access_token: 'st-access', expires_in: 900 })],
    [/POST https:\/\/api-integration\.servicetitan\.io\/dispatch\/v2\/tenant\/42\/capacity/, () => ({ availabilities: [
      { start: W1, end: W2, isAvailable: true, totalAvailability: 1 }, // only the reserve truck left
      { start: W2, end: W3, isAvailable: true, totalAvailability: 3 }] })],
    [/POST https:\/\/api-integration\.servicetitan\.io\/crm\/v2\/tenant\/42\/booking-provider\/7\/bookings/, () => ({ id: 9001 })]
  ]);
  const env = routesEnv({ ...base, provider: 'servicetitan', environment: 'integration', businessUnitIds: [5], jobTypeId: 11 },
    { ST_TENANT_ID: '42', ST_CLIENT_ID: 'cid', ST_CLIENT_SECRET: 'cs', ST_APP_KEY: 'ak', ST_BOOKING_PROVIDER_ID: '7' });
  const b = createBooking(env, http.send, new Map(), { now: () => NOW });
  const r = await b.handle('check_availability', ctx(), {});
  assert.deepEqual(r.windows.map(w => w.window_id), [W2]);
  const cap = http.hit(/capacity/)[0];
  assert.equal(cap.headers['ST-App-Key'], 'ak'); assert.equal(cap.headers.Authorization, 'Bearer st-access');
  assert.deepEqual(cap.body.businessUnitIds, [5]);
  assert.match(http.hit(/connect\/token/)[0].body, /grant_type=client_credentials/);
  const booked = await b.handle('book_window', ctx(), { window_id: W2, caller_agreed: true });
  assert.equal(booked.external_id, '9001'); assert.equal(booked.appointment_confirmed, false);
  const post = http.hit(/bookings/)[0].body;
  assert.equal(post.externalId, 'req-1'); assert.equal(post.start, W2);
  assert.deepEqual(post.contacts, [{ type: 'Phone', value: '6155550142' }, { type: 'Email', value: 'linda@example.com' }]);
});

// ---------- Google Calendar ----------
test('Google Calendar: freeBusy per truck calendar; unreadable calendar never looks free', async () => {
  let broken = false;
  const http = mockHttp([
    [/oauth2\.googleapis\.com\/token/, () => ({ access_token: 'g-access', expires_in: 3600 })],
    [/POST https:\/\/www\.googleapis\.com\/calendar\/v3\/freeBusy/, () => ({ calendars: {
      t1: { busy: [{ start: W1, end: W2 }] }, t2: { busy: [{ start: W1, end: W2 }] }, t3: broken ? { errors: [{ reason: 'notFound' }] } : { busy: [{ start: W1, end: W2 }] }, t4: { busy: [] } } })],
    [/POST https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/requests%40group\.calendar\.google\.com\/events/, () => ({ id: 'evt-1' })]
  ]);
  const b = createBooking(routesEnv({ ...base, provider: 'google_calendar', requestsCalendarId: 'requests@group.calendar.google.com' }), http.send, new Map(), { now: () => NOW });
  assert.deepEqual((await b.handle('check_availability', ctx(), {})).windows.map(w => w.window_id), [W2, W3]);
  const booked = await b.handle('book_window', ctx(), { window_id: W3, caller_agreed: true });
  assert.equal(booked.external_id, 'evt-1');
  const evt = http.hit(/events/)[0].body;
  assert.equal(evt.transparency, 'transparent'); assert.equal(evt.status, 'tentative'); assert.match(evt.summary, /^REQUEST \(not confirmed\)/);
  broken = true;
  assert.equal((await b.handle('check_availability', ctx({ callId: 'call-2' }), {})).ok, false);
});

// ---------- through the real webhook ----------
test('webhook: booking tools need a saved request, and stay off for unconfigured lines', async t => {
  const key = 'synthetic-test-key-not-used-in-production';
  const dir = mkdtempSync(join(tmpdir(), 'booking-test-'));
  const http = hcpMock();
  const app = createApp({ DATA_DIR: dir, VAPI_WEBHOOK_SECRET: key, BOOKING_ROUTES: JSON.stringify({ 'gold-star': { ...base, daysAhead: 7, leadMinutes: 0, provider: 'housecallpro' } }) }, http.send);
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { await new Promise(r => app.close(r)); rmSync(dir, { recursive: true }); });
  const url = `http://127.0.0.1:${app.address().port}`;
  const call = async (name, args, assistantId = 'gold-star') => JSON.parse((await (await fetch(`${url}/vapi/webhook`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-anchorline-key': key },
    body: JSON.stringify({ message: { type: 'tool-calls', call: { id: `call-${assistantId}`, assistantId, customer: { number: '+16155550100' } },
      toolCallList: [{ id: 'tool-1', function: { name, arguments: args } }] } }) })).json()).results[0].result);
  const avail = await call('check_availability', {});
  assert.equal(avail.ok, true); assert.ok(avail.windows.length > 0);
  assert.match((await call('book_window', { window_id: avail.windows[0].window_id, caller_agreed: true })).error, /Save the request first/);
  const { request_id, ...intake } = request;
  assert.equal((await call('submit_service_request', { ...intake, email_status: 'confirmed', email_confirmed: true })).saved, true);
  const booked = await call('book_window', { window_id: avail.windows[0].window_id, caller_agreed: true });
  assert.equal(booked.status, 'pending_office_confirmation'); assert.equal(booked.appointment_confirmed, false);
  assert.match(http.hit(/POST .*\/leads$/)[0].body.note, /Anchorline ref [0-9a-f-]{36}/);
  assert.equal((await call('check_availability', {}, 'demo-line')).reason, 'not_available');
  assert.equal((await (await fetch(`${url}/healthz`)).json()).booking_routes, 1);
});
