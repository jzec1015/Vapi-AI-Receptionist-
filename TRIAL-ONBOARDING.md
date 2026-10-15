# Self-serve trial onboarding

Step 1 (this branch) stores trial clients in SQLite and routes their calls. Nothing here signs anyone up,
sends email verification, or talks to Vapi or Telnyx yet.

## Schema (created at startup in `requests.sqlite`, `CREATE TABLE IF NOT EXISTS`)

`clients`: one row per trial client.

| column | notes |
| --- | --- |
| `id` | TEXT primary key |
| `assistant_id` | Vapi assistant id, UNIQUE, NULL until provisioned |
| `phone_number_id`, `phone_number` | Vapi phone number id and the E.164 number callers dial |
| `business`, `owner_name`, `owner_cell` | owner cell is E.164 |
| `office_emails`, `alert_call` | JSON arrays (default `[]`) |
| `transfer` | E.164 or NULL (warm transfer for URGENT jobs) |
| `shop_number` | E.164, the shop's own line; calls go here when the trial ends |
| `state` | 2-letter US state |
| `status` | `pending_verification` \| `provisioning` \| `active` \| `ended` (CHECK) |
| `trial_ends_at`, `created_at`, `verified_at` | ISO timestamps |
| `minute_cap` / `minutes_used` | INTEGER default 300 / REAL default 0 |
| `cap_alerted_at` | set when the one-time cap email went out |
| `verify_token_hash`, `verify_token_expires_at` | hashed email-verification token (never store the token) |

`client_calls`: `call_id` primary key, `client_id`, `minutes`, `created_at`. One row per metered call, so a
resent end-of-call report is never counted twice.

Rollback: both are new tables that v1.6.0 and v1.5.0 never read, so a Railway rollback keeps working and a
roll-forward finds the rows unchanged (tested in `trial.test.mjs`).

## Behaviour

- Route lookup (`routeOf` in `server.mjs`): an `ALERT_ROUTES` entry wins. Otherwise an `active` client row gives
  `{business, sms: [], email: office_emails, call: alert_call, transfer}`. SMS stays off until 10DLC covers trial clients.
  Any other status gives no route (the request is still saved; no office alert).
- Minutes: every `end-of-call-report` for an assistant with a client row (any status) adds `durationSeconds / 60`
  (falls back to `durationMinutes`). The first report that takes `minutes_used` to `minute_cap` emails `OFFICE_EMAIL`
  once: "Trial over minute cap: <business>". Calls are never refused.

## Next steps

1. Public signup endpoint: validate fields (E.164, state, emails), insert `pending_verification`, store a hashed
   token with an expiry. Rate-limit by IP and owner cell.
2. Verify email: send the link via Resend; on click, check hash and expiry, set `verified_at`, move to `provisioning`.
3. Provision the Vapi assistant from a template prompt with substitutions: business name, business description,
   and a `firstMessage` that carries the recording disclosure "This call may be recorded so we get your details right."
   Save `assistant_id`.
4. Buy a Telnyx $1/mo number, import it into Vapi pointing at the assistant; save `phone_number_id` / `phone_number`.
5. Place a test call and confirm Emma answers, then set `status = 'active'` and `trial_ends_at`.
6. Trial end: set `status = 'ended'`, unset the Vapi number's `assistantId` so Vapi sends `assistant-request` to
   this server, and answer it with a transfer destination to `shop_number`, so calls are never dropped.
