// Booking adapters: read live truck availability and write a job into the client's scheduling tool.
// SKELETON (not deployed). Endpoint and field names follow the official docs cited in
// work/02-booking/tools-research.md; every provider must be checked against a real (or sandbox)
// account before go-live. Nothing here is called unless BOOKING_ROUTES names the assistant.
//
// Safety rules enforced here, not in the prompt:
//  - Emma can only offer windows this module just read from the live schedule.
//  - Right before writing, availability is read again inside a per-process lock; a window that
//    filled up in the meantime is refused and fresh alternatives are returned.
//  - One truck (reserveTrucks) is held back for emergencies.
//  - appointment_confirmed is true only in "book" mode, after the provider accepted a scheduled job.
//    In "request" mode (the default) the window is sent to the office, who confirm by phone.
//  - URGENT jobs are never booked into a window; they go through the alert call path.
//  - One booking per call (idempotent across Vapi retries and restarts via the injected store).

export class ProviderError extends Error {
  constructor(provider, status, detail = '') { super(`${provider} HTTP ${status}${detail ? `: ${detail}` : ''}`); this.provider = provider; this.status = status; }
}

// ---------- time helpers (business time zone, DST-safe) ----------
function tzOffsetMs(ts, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts)).map(p => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(ts / 1000) * 1000;
}
export function zonedToUtc(dateStr, hhmm, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - tzOffsetMs(guess, timeZone);
  const second = guess - tzOffsetMs(t, timeZone);
  if (second !== t) t = second;
  return new Date(t);
}
function localDate(ts, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}
function localWeekday(dateStr) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function addDays(dateStr, n) { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

// "Tuesday, October 15, between 8 and 11 AM" for Emma to read out.
export function windowLabel(start, end, timeZone) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(start);
  const hour = t => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(t).replace(':00', '');
  const [a, b] = [hour(start), hour(end)];
  const sameHalf = a.slice(-2) === b.slice(-2);
  return `${day}, between ${sameHalf ? a.slice(0, -3) : a} and ${b}`;
}

// ---------- pure capacity logic (the double-booking guard) ----------
// busy: [{ techId|null, start, end }]. A tech with ANY overlapping job is treated as busy for the
// whole window (conservative). Scheduled work with no tech assigned still uses a truck.
export function openWindows(cfg, technicianIds, busy, now = Date.now()) {
  const tz = cfg.timezone;
  const out = [];
  const firstDay = localDate(now, tz);
  for (let i = 0; i < (cfg.daysAhead ?? 5); i++) {
    const day = addDays(firstDay, i);
    if (!(cfg.workDays ?? [1, 2, 3, 4, 5]).includes(localWeekday(day))) continue;
    for (const spec of cfg.windows ?? ['08:00-11:00', '11:00-14:00', '14:00-17:00']) {
      const [s, e] = spec.split('-');
      const start = zonedToUtc(day, s, tz), end = zonedToUtc(day, e, tz);
      if (start.getTime() < now + (cfg.leadMinutes ?? 120) * 60000) continue;
      const overlapping = busy.filter(b => new Date(b.start) < end && new Date(b.end) > start);
      const busyTechs = new Set(overlapping.filter(b => b.techId != null).map(b => String(b.techId)));
      const unassigned = overlapping.filter(b => b.techId == null).length;
      const freeTechs = technicianIds.map(String).filter(id => !busyTechs.has(id));
      const capacity = freeTechs.length - unassigned - (cfg.reserveTrucks ?? 1);
      if (capacity > 0) out.push({ window_id: start.toISOString(), start: start.toISOString(), end: end.toISOString(),
        label: windowLabel(start, end, tz), freeTechs: freeTechs.slice(0, freeTechs.length - unassigned) });
    }
  }
  return out;
}

// ---------- HTTP + OAuth helpers ----------
async function call(send, provider, url, init = {}) {
  const response = await send(url, { ...init, signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  if (!response.ok) throw new ProviderError(provider, response.status, text.slice(0, 200));
  return text ? JSON.parse(text) : {};
}
const json = (method, headers, body) => ({ method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
function tokenCache(send, provider, url, form, onRotate) {
  let cached = null;
  return async () => {
    if (cached && cached.expires > Date.now() + 60000) return cached.token;
    const body = new URLSearchParams(typeof form === 'function' ? form() : form);
    const t = await call(send, provider, url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (t.refresh_token && onRotate) onRotate(t.refresh_token); // Jobber rotates refresh tokens: persist the new one.
    cached = { token: t.access_token, expires: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
    return cached.token;
  };
}
const splitName = name => { const parts = String(name).trim().split(/\s+/); return { first: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0], last: parts.length > 1 ? parts.at(-1) : '' }; };
const digits = v => String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const jobNote = (d, window, mode) => [
  d.issue, d.job_type && `Job: ${d.job_type}${d.job_size ? ` (${d.job_size})` : ''}`, d.job_details && `Details: ${d.job_details}`,
  window && (mode === 'book' ? `Booked by Emma for ${window.label}` : `Caller asked for ${window.label} - NOT CONFIRMED, call to confirm`),
  d.preferred_time && `Caller said: ${d.preferred_time}`, `Anchorline ref ${d.request_id || ''}`.trim()
].filter(Boolean).join('\n');

// ---------- providers ----------
// Each returns { technicians(), busy(from, to), upsertCustomer(details), createJob({ customer, details, window, techId, mode }) }.

// Housecall Pro public API (MAX plan). API key auth: "Authorization: Token <key>".
export function housecallPro(cfg, env, send) {
  const base = cfg.baseUrl || 'https://api.housecallpro.com';
  const auth = { Authorization: `Token ${env[cfg.apiKeyEnv || 'HCP_API_KEY']}` };
  return {
    async technicians() {
      if (cfg.technicianIds?.length) return cfg.technicianIds;
      const r = await call(send, 'hcp', `${base}/employees?page_size=100`, json('GET', auth));
      return (r.employees || []).map(e => e.id);
    },
    async busy(from, to) {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const q = new URLSearchParams({ scheduled_start_min: from, scheduled_start_max: to, page: String(page), page_size: '100' });
        const r = await call(send, 'hcp', `${base}/jobs?${q}`, json('GET', auth));
        for (const job of r.jobs || []) {
          if (!job.schedule?.scheduled_start || /cancel/i.test(job.work_status || '')) continue;
          const techs = (job.assigned_employees || []).map(e => e.id);
          for (const techId of techs.length ? techs : [null]) out.push({ techId, start: job.schedule.scheduled_start, end: job.schedule.scheduled_end });
        }
        if (page >= (r.total_pages || 1)) break;
      }
      return out;
    },
    async upsertCustomer(d) {
      const phone = digits(d.callback_phone || d.caller_id);
      const found = phone ? await call(send, 'hcp', `${base}/customers?${new URLSearchParams({ q: phone })}`, json('GET', auth)) : {};
      const existing = (found.customers || [])[0];
      if (existing) return { customerId: existing.id, addressId: existing.addresses?.[0]?.id || null };
      const { first, last } = splitName(d.name);
      const c = await call(send, 'hcp', `${base}/customers`, json('POST', auth, {
        first_name: first, last_name: last, mobile_number: phone || undefined, email: d.email || undefined,
        notifications_enabled: false, lead_source: 'Anchorline AI receptionist',
        addresses: [{ street: d.address, type: 'service' }] }));
      return { customerId: c.id, addressId: c.addresses?.[0]?.id || null };
    },
    async createJob({ customer, details, window, techId, mode }) {
      if (mode !== 'book') {
        // Unscheduled: office sees it in the job/lead inbox and confirms the time by phone.
        const lead = await call(send, 'hcp', `${base}/leads`, json('POST', auth, { customer_id: customer.customerId, address_id: customer.addressId, note: jobNote(details, window, mode) }));
        return { externalId: lead.id, kind: 'lead' };
      }
      const job = await call(send, 'hcp', `${base}/jobs`, json('POST', auth, {
        customer_id: customer.customerId, address_id: customer.addressId, notes: jobNote(details, window, mode),
        assigned_employee_ids: [techId], schedule: { scheduled_start: window.start, scheduled_end: window.end, arrival_window: 0 } }));
      return { externalId: job.id, kind: 'job' };
    }
  };
}

// Jobber GraphQL (OAuth 2 app; refresh tokens rotate). Requests are Jobber's native "new request" inbox.
export function jobber(cfg, env, send, hooks = {}) {
  const url = 'https://api.getjobber.com/api/graphql';
  let refresh = env[cfg.refreshTokenEnv || 'JOBBER_REFRESH_TOKEN'];
  const token = tokenCache(send, 'jobber', 'https://api.getjobber.com/api/oauth/token',
    () => ({ grant_type: 'refresh_token', refresh_token: refresh, client_id: env.JOBBER_CLIENT_ID, client_secret: env.JOBBER_CLIENT_SECRET }),
    next => { refresh = next; hooks.saveRefreshToken?.('jobber', next); });
  const gql = async (query, variables) => {
    const r = await call(send, 'jobber', url, json('POST', { Authorization: `Bearer ${await token()}`, 'X-JOBBER-GRAPHQL-VERSION': cfg.apiVersion || env.JOBBER_API_VERSION }, { query, variables }));
    if (r.errors?.length) throw new ProviderError('jobber', 200, r.errors[0].message);
    return r.data;
  };
  const userErrors = (payload, what) => { if (payload?.userErrors?.length) throw new ProviderError('jobber', 422, `${what}: ${payload.userErrors[0].message}`); return payload; };
  return {
    async technicians() {
      if (cfg.technicianIds?.length) return cfg.technicianIds;
      const d = await gql('query { users(first: 50) { nodes { id } } }');
      return d.users.nodes.map(u => u.id);
    },
    async busy(from, to) {
      const out = [];
      let after = null;
      for (let i = 0; i < 10; i++) {
        const d = await gql(`query($from: ISO8601DateTime!, $to: ISO8601DateTime!, $after: String) {
          visits(first: 100, after: $after, filter: { startAt: { after: $from, before: $to } }) {
            nodes { startAt endAt visitStatus assignedUsers { nodes { id } } } pageInfo { hasNextPage endCursor } } }`, { from, to, after });
        for (const v of d.visits.nodes) {
          if (!v.startAt || /cancel/i.test(v.visitStatus || '')) continue;
          const techs = v.assignedUsers?.nodes?.map(u => u.id) || [];
          for (const techId of techs.length ? techs : [null]) out.push({ techId, start: v.startAt, end: v.endAt });
        }
        if (!d.visits.pageInfo.hasNextPage) break;
        after = d.visits.pageInfo.endCursor;
      }
      return out;
    },
    async upsertCustomer(d) {
      const { first, last } = splitName(d.name);
      const phone = digits(d.callback_phone || d.caller_id);
      const r = await gql(`mutation($input: ClientCreateInput!) { clientCreate(input: $input) { client { id } userErrors { message path } } }`, { input: {
        firstName: first, lastName: last, phones: phone ? [{ number: phone, primary: true }] : [], emails: d.email ? [{ address: d.email, primary: true }] : [],
        billingAddress: { street1: d.address } } });
      return { customerId: userErrors(r.clientCreate, 'clientCreate').client.id };
    },
    async createJob({ customer, details, window, mode }) {
      // Request (assessment) only; Jobber's office flow converts it to a scheduled visit. "book" mode for Jobber
      // would use jobCreate with a visit schedule; left out until a real account confirms the schema.
      if (mode === 'book') throw new ProviderError('jobber', 501, 'book mode not implemented for Jobber yet');
      const r = await gql(`mutation($input: RequestCreateInput!) { requestCreate(input: $input) { request { id } userErrors { message path } } }`, { input: {
        clientId: customer.customerId, title: `${details.job_type || 'Service request'} (Emma)` } });
      const request = userErrors(r.requestCreate, 'requestCreate').request;
      // Put the full note (incl. requested window) on the request.
      await gql(`mutation($id: EncodedId!, $input: RequestCreateNoteInput!) { requestCreateNote(requestId: $id, input: $input) { userErrors { message } } }`,
        { id: request.id, input: { message: jobNote(details, window, mode) } }).catch(() => null);
      return { externalId: request.id, kind: 'request' };
    }
  };
}

// ServiceTitan (integration app approved by ServiceTitan; client credentials + ST-App-Key; tenant in path).
export function serviceTitan(cfg, env, send) {
  const sandbox = cfg.environment === 'integration';
  const base = sandbox ? 'https://api-integration.servicetitan.io' : 'https://api.servicetitan.io';
  const tenant = env[cfg.tenantEnv || 'ST_TENANT_ID'];
  const token = tokenCache(send, 'servicetitan', sandbox ? 'https://auth-integration.servicetitan.io/connect/token' : 'https://auth.servicetitan.io/connect/token',
    { grant_type: 'client_credentials', client_id: env.ST_CLIENT_ID, client_secret: env.ST_CLIENT_SECRET });
  const headers = async () => ({ Authorization: `Bearer ${await token()}`, 'ST-App-Key': env.ST_APP_KEY });
  return {
    // ServiceTitan computes capacity itself (shifts, skills, business units). We trust its numbers but still
    // apply our reserve truck: busy() is synthesised so openWindows() can stay provider-agnostic.
    capacity: true,
    async technicians() { return cfg.technicianIds || []; },
    async busy() { return []; },
    async windows(from, to) {
      const r = await call(send, 'servicetitan', `${base}/dispatch/v2/tenant/${tenant}/capacity`, json('POST', await headers(), {
        startsOnOrAfter: from, endsOnOrBefore: to, businessUnitIds: cfg.businessUnitIds || [], jobTypeId: cfg.jobTypeId, skillBasedAvailability: false }));
      return (r.availabilities || []).filter(a => a.isAvailable && (a.totalAvailability ?? 0) - (cfg.reserveTrucks ?? 1) > 0)
        .map(a => ({ start: a.start, end: a.end }));
    },
    async upsertCustomer() { return { customerId: null }; }, // Bookings carry the customer; the CSR converts them.
    async createJob({ details, window, mode }) {
      if (mode === 'book') throw new ProviderError('servicetitan', 501, 'book mode needs jpm/jobs + location ids; not implemented until sandbox access');
      const phone = digits(details.callback_phone || details.caller_id);
      const r = await call(send, 'servicetitan', `${base}/crm/v2/tenant/${tenant}/booking-provider/${env.ST_BOOKING_PROVIDER_ID}/bookings`, json('POST', await headers(), {
        source: 'Anchorline AI', name: details.name, summary: jobNote(details, window, mode), isFirstTimeClient: true,
        externalId: details.request_id, start: window?.start, address: { street: details.address, country: 'USA' },
        contacts: [...(phone ? [{ type: 'Phone', value: phone }] : []), ...(details.email ? [{ type: 'Email', value: details.email }] : [])] }));
      return { externalId: String(r.id), kind: 'booking' };
    }
  };
}

// Google Calendar: one calendar per truck (calendar id = technician id). OAuth refresh token for the office account.
export function googleCalendar(cfg, env, send) {
  const base = 'https://www.googleapis.com/calendar/v3';
  const token = tokenCache(send, 'gcal', 'https://oauth2.googleapis.com/token',
    { grant_type: 'refresh_token', refresh_token: env.GCAL_REFRESH_TOKEN, client_id: env.GCAL_CLIENT_ID, client_secret: env.GCAL_CLIENT_SECRET });
  const auth = async () => ({ Authorization: `Bearer ${await token()}` });
  return {
    async technicians() { return cfg.technicianIds; },
    async busy(from, to) {
      const r = await call(send, 'gcal', `${base}/freeBusy`, json('POST', await auth(), { timeMin: from, timeMax: to, timeZone: cfg.timezone, items: cfg.technicianIds.map(id => ({ id })) }));
      const out = [];
      for (const [techId, cal] of Object.entries(r.calendars || {})) {
        // A calendar we cannot read must never look free.
        if (cal.errors?.length) throw new ProviderError('gcal', 200, `freeBusy error for a truck calendar: ${cal.errors[0].reason}`);
        for (const b of cal.busy || []) out.push({ techId, start: b.start, end: b.end });
      }
      return out;
    },
    async upsertCustomer() { return { customerId: null }; },
    async createJob({ details, window, techId, mode }) {
      const calendarId = mode === 'book' ? techId : cfg.requestsCalendarId;
      if (!calendarId) throw new ProviderError('gcal', 400, 'requestsCalendarId not configured');
      const e = await call(send, 'gcal', `${base}/calendars/${encodeURIComponent(calendarId)}/events`, json('POST', await auth(), {
        summary: `${mode === 'book' ? '' : 'REQUEST (not confirmed): '}${details.name} - ${details.job_type || details.issue.slice(0, 60)}`,
        location: details.address, description: jobNote(details, window, mode),
        start: { dateTime: window.start }, end: { dateTime: window.end },
        // A request must not block the truck's free/busy until the office confirms it.
        ...(mode === 'book' ? {} : { transparency: 'transparent', status: 'tentative' }) }));
      return { externalId: e.id, kind: 'event' };
    }
  };
}

const PROVIDERS = { housecallpro: housecallPro, jobber, servicetitan: serviceTitan, google_calendar: googleCalendar };

// ---------- Vapi tool handlers ----------
// BOOKING_ROUTES: {"<assistantId>": {"provider": "housecallpro", "mode": "request", "timezone": "America/Chicago", "technicianIds": [...],
//   "windows": ["08:00-11:00","11:00-14:00","14:00-17:00"], "workDays": [1,2,3,4,5], "reserveTrucks": 1, "daysAhead": 5, "leadMinutes": 120, "maxOffered": 3}}
// store: { get(callId) -> result|undefined, set(callId, result) } (SQLite in the server; Map in tests).
export function createBooking(env = process.env, send = fetch, store = new Map(), { now = () => Date.now(), hooks = {} } = {}) {
  let routes = {};
  try { routes = JSON.parse(env.BOOKING_ROUTES || '{}') || {}; } catch { routes = {}; }
  const adapters = new Map();
  const adapterFor = assistantId => {
    const cfg = routes[assistantId];
    if (!cfg || !PROVIDERS[cfg.provider]) return null;
    if (!adapters.has(assistantId)) adapters.set(assistantId, { cfg, api: PROVIDERS[cfg.provider](cfg, env, send, hooks) });
    return adapters.get(assistantId);
  };
  let chain = Promise.resolve();
  const serial = fn => { const run = chain.then(fn, fn); chain = run.catch(() => null); return run; };
  const fallback = { ok: false, reason: 'not_available', say: 'Take their preferred time in their words; the team will call to confirm.' };

  async function windows({ cfg, api }) {
    const from = new Date(now()).toISOString(), to = new Date(now() + ((cfg.daysAhead ?? 5) + 1) * 86400000).toISOString();
    if (api.capacity) {
      return (await api.windows(from, to)).filter(w => new Date(w.start).getTime() >= now() + (cfg.leadMinutes ?? 120) * 60000)
        .map(w => ({ window_id: new Date(w.start).toISOString(), start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString(),
          label: windowLabel(new Date(w.start), new Date(w.end), cfg.timezone), freeTechs: [] }));
    }
    const [techs, busy] = await Promise.all([api.technicians(), api.busy(from, to)]);
    return openWindows(cfg, techs, busy, now());
  }

  async function checkAvailability(ctx, args) {
    const a = adapterFor(ctx.assistantId);
    if (!a) return fallback;
    if (ctx.request && /^\s*URGENT\b/i.test(ctx.request.issue)) return { ok: false, reason: 'urgent', say: 'Urgent jobs are not booked into windows; the owner is being alerted.' };
    try {
      let list = await windows(a);
      if (typeof args?.preferred_day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.preferred_day))
        list = list.filter(w => localDate(Date.parse(w.start), a.cfg.timezone) === args.preferred_day);
      const offered = list.slice(0, a.cfg.maxOffered ?? 3).map(({ window_id, label }) => ({ window_id, label }));
      return { ok: true, mode: a.cfg.mode === 'book' ? 'book' : 'request', windows: offered,
        say: offered.length ? 'Offer only these windows, as windows not exact times.' : 'No open windows in the next few days; take their preferred time and say the team will call.' };
    } catch (error) {
      console.log(`booking check failed provider=${a.cfg.provider} status=${error.status ?? 'network'}`);
      return fallback;
    }
  }

  async function bookWindow(ctx, args) {
    const prior = await store.get(ctx.callId);
    if (prior) return { ...prior, duplicate: true };
    const a = adapterFor(ctx.assistantId);
    if (!a) return { booked: false, appointment_confirmed: false, ...fallback };
    if (!ctx.request) return { booked: false, appointment_confirmed: false, error: 'Save the request first, then book the window.' };
    if (/^\s*URGENT\b/i.test(ctx.request.issue)) return { booked: false, appointment_confirmed: false, error: 'Urgent jobs are not booked into windows.' };
    if (ctx.request.is_test) return { booked: false, appointment_confirmed: false, status: 'suppressed_test' };
    if (args?.caller_agreed !== true || typeof args?.window_id !== 'string') return { booked: false, appointment_confirmed: false, error: 'Read the window back and get a clear yes first.' };
    const mode = a.cfg.mode === 'book' ? 'book' : 'request';
    return serial(async () => {
      // A Vapi retry that queued behind the first attempt finds its result here instead of booking twice.
      const done = await store.get(ctx.callId);
      if (done) return { ...done, duplicate: true };
      try {
        // Re-read the live schedule inside the lock: never trust what was offered a minute ago.
        const fresh = await windows(a);
        const window = fresh.find(w => w.window_id === args.window_id);
        if (!window) return { booked: false, appointment_confirmed: false, status: 'window_taken',
          alternatives: fresh.slice(0, 2).map(({ window_id, label }) => ({ window_id, label })) };
        const customer = await a.api.upsertCustomer(ctx.request);
        const created = await a.api.createJob({ customer, details: ctx.request, window, techId: window.freeTechs[0] ?? null, mode });
        const result = { booked: true, appointment_confirmed: mode === 'book', status: mode === 'book' ? 'scheduled' : 'pending_office_confirmation',
          window_label: window.label, provider: a.cfg.provider, external_id: created.externalId, kind: created.kind };
        await store.set(ctx.callId, result);
        return result;
      } catch (error) {
        console.log(`booking write failed provider=${a.cfg.provider} status=${error.status ?? 'network'}`);
        return { booked: false, appointment_confirmed: false, status: 'error', say: 'The request is saved; tell them the team will call to confirm the time.' };
      }
    });
  }

  return {
    names: ['check_availability', 'book_window'],
    routeCount: Object.keys(routes).length,
    configured: assistantId => !!adapterFor(assistantId),
    handle: (name, ctx, args) => name === 'check_availability' ? checkAvailability(ctx, args) : bookWindow(ctx, args)
  };
}
