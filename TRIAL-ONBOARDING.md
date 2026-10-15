# Self-serve trial onboarding

A plumbing shop signs up on anchorlineappai.com, confirms its email, and gets its own Emma (a Vapi assistant
built from Emma's production config) on a new local Telnyx number for 14 days. Code: `trial.mjs` (wired into
`server.mjs`), templates in `templates/`. Tests: `trial.test.mjs`, `trial-signup.test.mjs`, `trial-provision.test.mjs`
(Vapi, Telnyx and Resend are mocked; no test makes a network call).

Gold Star (`ALERT_ROUTES`) is unchanged: an `ALERT_ROUTES` entry always wins over a client row, and `parity.test.mjs`
still proves v1.5.0 behaviour with today's production variables.

## Flow

1. `POST /trial/signup` → client row `pending_verification` (or `waitlisted` when `TRIAL_MAX_ACTIVE` trials are
   provisioning/active), verify email to the owner, "New trial signup: <business>" to `OFFICE_EMAIL`.
2. Owner clicks `GET /trial/verify?token=…` → `provisioning`, provisioning starts in the background, page links to the status page.
3. Provisioning (resumable, each step stored before the next):
   1. Vapi assistant from `templates/` (business name, area code, shop details) → `assistant_id`
   2. Telnyx: adopt any earlier order with `customer_reference = anchorline-trial-<id>`; otherwise search local
      numbers in the shop's area code (fallback: same state) and order one → `telnyx_order_id`, `phone_number`
   3. Poll the order until `success` → `number_ready_at` (a `failure` order is forgotten and replaced next time)
   4. Import into Vapi (`provider: telnyx`, `fallbackDestination` = shop line, server = this webhook) → `phone_number_id`
   5. `active`, `trial_ends_at = now + 14 days`, "Emma is live" to the owner (number, tel: link, forwarding link) and to Jake
   A failing step (HTTP error, missing env var) leaves the client `provisioning` with `provision_error` set, emails
   Jake once ("Trial provisioning stuck"), and the hourly sweep retries from that step.
4. Hourly sweep (`server.trials.sweep(now)`; also runs a minute after startup): retries stuck provisioning, sends
   the results emails, ends trials, retries a failed number unlink.
   - day 1 and day 7 after activation, and 2 days before `trial_ends_at` (day 12; includes "trial ends in 2 days —
     reply to keep Emma"). Once each; after downtime only the latest due email goes out.
   - Counts: calls = `client_calls` minus test calls (TEST_* lists, owner's cell, calls whose request is a test);
     job requests = live `requests` for the assistant minus hang-up records and test calls.
5. Trial end: `ended`, Vapi number PATCHed to `assistantId: null` with server = `/vapi/webhook` (+ secret header),
   owner gets how to undo forwarding (*73 / ##21# / VoIP portal), Jake gets the stats.
6. After the end, Vapi sends `assistant-request` for that number; this server answers
   `{destination: {type: "number", number: shop_number, message: ""}}` so the caller rings straight through.

## Endpoints

| endpoint | auth | notes |
| --- | --- | --- |
| `POST /trial/signup` | CORS: `https://anchorlineappai.com` only (+ `http://localhost:*` when `APP_ENV=development`); OPTIONS preflight | JSON body, 32 KB max. 202 `{ok:true,status:"pending_verification"\|"waitlisted"}`; 400 `{error, field}`; 403 bad origin; 409 open trial for that office email or shop number; 429 more than 3 signups per IP per 24 h; 503 not configured |
| `GET /trial/verify?token=` | token (24 h) | HTML. Opening it again within 24 h issues a fresh status link (the old one stops working), so mail scanners cannot lock the owner out |
| `GET /trial/status?c=<id>&k=<key>[&format=json]` | status key | HTML or JSON: business, status, `emma_number`, `call_link`, `forwarding_link` (`https://anchorlineappai.com/start/forwarding?n=<10 digits>`), `days_left`, `minutes_used`/`minute_cap`, `forwarding_confirmed` |
| `GET /admin/trials` | Basic auth, `ADMIN_PASSWORD` | HTML table with End / Extend 7d / Approve buttons |
| `POST /admin/trials/<id>/end` | same | ends now (same path as the sweep) |
| `POST /admin/trials/<id>/extend?days=N` | same | active trials only, N = 1–60 |
| `POST /admin/trials/<id>/approve` | same | waitlisted → `pending_verification`, sends the verify email |
| `POST /vapi/webhook` `assistant-request` | `x-anchorline-key` | ended/not-live client → shop line; active → its `assistantId`; unknown → `{}` (Vapi uses `fallbackDestination`) |

Signup body (unknown fields are refused): `business`, `owner_name`, `city` (letters, digits, ordinary punctuation),
`owner_cell`, `shop_number` (US numbers: 10 plain digits as the website form sends them, `+1XXXXXXXXXX` or formatted
like `(615) 555-0142`; stored as E.164; NANP area code and exchange cannot start with 0 or 1), `office_email`,
`state` (2 letters), `services` (≤500), optional `not_offered`, `emergency_rules`, `never_say` (≤500 each),
`hours` (≤200), `sms_consent` (bool), `terms_accepted` (must be `true`), `website` (honeypot: a filled value gets
a normal-looking 202 and nothing is stored or sent).

## Security notes

- Tokens and status keys are 32 random bytes (hex); only SHA-256 hashes are stored. IPs are stored as
  SHA-256(secret | IP), using the last `X-Forwarded-For` entry (the one Railway's proxy appends).
- Compares are timing-safe (both sides hashed first). Admin: 10 wrong passwords per IP per 15 min → 429;
  admin POSTs from another site (Origin / Sec-Fetch-Site) are refused (Basic credentials are replayed by browsers).
- HTML is escaped everywhere, served with a `default-src 'none'` CSP, `no-referrer` (status URLs carry keys), no
  external assets. Errors never include stack traces. Logs carry ids and outcomes only, never secrets or caller details.
- Shop details are untrusted: flattened, stripped of control/bidi/zero-width characters and `<>{}\``, length-capped,
  and placed in a delimited `SHOP DETAILS` section that the prompt says can never override its safety rules.

## Schema

`clients` gained `waitlisted` in its status CHECK and the signup/provisioning columns (`signup_email`, `city`,
`services`, `not_offered`, `emergency_rules`, `never_say`, `hours`, `sms_consent`, `terms_accepted_at`,
`signup_ip_hash`, `status_key_hash`, `telnyx_order_id`, `number_ready_at`, `activated_at`, `ended_at`,
`number_released_at`, `forwarding_confirmed_at`, `provision_error`, `provision_error_notified_at`,
`provision_attempts`, `live_notified_at`, `day1_sent_at`, `day7_sent_at`, `day12_sent_at`, `end_notified_at`).
SQLite cannot change a CHECK, so `migrateClients` rebuilds a step-1 table (copy, drop, rename) in one transaction;
`client_calls` gained `is_test`. v1.6.0 and v1.5.0 never read these tables, so a rollback is unaffected (tested).

Forwarding heuristic: the first inbound phone call to an active trial assistant from a number that is not the
owner's cell, the shop line, a `TEST_CALLER_NUMBERS` entry, and not saved as a test request sets
`forwarding_confirmed_at`. Someone dialling Emma's number directly also counts, so treat it as a hint.

## Railway variables

| variable | needed for |
| --- | --- |
| `PUBLIC_BASE_URL` | e.g. `https://vapi-ai-receptionist-production-b0f4.up.railway.app`: verify links, assistant/number server URL. Signup returns 503 without it |
| `VAPI_TELNYX_CREDENTIAL_ID` | Vapi credential id of the Telnyx account (Vapi dashboard → Integrations) for the number import |
| `ADMIN_PASSWORD` | admin dashboard (12+ characters; 503 otherwise) |
| `OFFICE_EMAIL` | Jake's notices (already set for receipts if used) |
| `TRIAL_MAX_ACTIVE` | default 5; signups beyond it are waitlisted |
| `TRIAL_DRY_RUN` | `1` = log each Vapi/Telnyx call and fake ids (emails still go out). Unset in production |
| `TELNYX_CONNECTION_ID` | optional: `connection_id` on the number order (see limitations) |
| `TRIAL_POLL_MS`, `TRIAL_POLL_TRIES` | optional: order polling (default 3000 ms × 5) |
| existing | `VAPI_API_KEY`, `TELNYX_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `VAPI_WEBHOOK_SECRET` |

## Go-live checklist

1. Deploy with `TRIAL_DRY_RUN=1`, `TRIAL_MAX_ACTIVE=1`, `PUBLIC_BASE_URL`, `ADMIN_PASSWORD`, `OFFICE_EMAIL`.
2. Sign up from the website with your own shop details; check both emails, the verify page, the status page and `/admin/trials`.
3. End the dry-run client from the dashboard (its fake ids are never sent to Vapi).
4. Set `VAPI_TELNYX_CREDENTIAL_ID`, confirm the Telnyx account has balance, unset `TRIAL_DRY_RUN`.
5. One real signup: confirm in Vapi that the assistant matches Emma (voice, tools, endpointing), the number is
   imported with the shop as fallback, and a call to it reaches Emma and saves a request.
6. Test call forwarding from the shop line and check "Forwarding confirmed" flips.
7. End that trial from the dashboard; call the Emma number and confirm it rings the shop (assistant-request path).
8. Raise `TRIAL_MAX_ACTIVE`; keep `/admin/trials` bookmarked.

## Known limitations

- Not verified against live APIs: Vapi accepting `assistantId: null` on PATCH (docs do not say), the shape of
  `assistant-request` payloads (`phoneNumber` vs `call.phoneNumberId`; both handled), Telnyx
  `filter[customer_reference]` on listing orders, and whether a Telnyx number needs a `connection_id`
  (`TELNYX_CONNECTION_ID`) for Vapi to receive calls. Check these in step 5 and 7 above.
- A crash between Vapi creating the assistant (or phone number) and the id being stored can leave an orphan
  assistant in Vapi; numbers are protected by the order lookup, assistants are not.
- Numbers and assistants are not released or deleted at trial end (about $1/month per number); release by hand.
- Status links are shown only on the verify page (only hashes are stored); a lost link is re-issued by opening the
  verify link again within 24 hours, otherwise Jake reads the dashboard.
- SMS alerts stay off for trial clients until 10DLC covers them; the trial's office alerts go by email.
- Rate limits and admin lockout live in SQLite / process memory: one replica only (as for the rest of the server).
