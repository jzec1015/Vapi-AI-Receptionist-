# Anchorline receptionist backend

Standalone Node 24 service. No Base44 dependencies. Source can be edited in Zaviv with Astra and deployed through this GitHub repository.

## Railway

The Dockerfile starts the server on Railway's PORT. Configure healthcheck `/healthz`.
Attach a persistent volume at `/data`. Railway supplies RAILWAY_VOLUME_MOUNT_PATH automatically.
Set VAPI_WEBHOOK_SECRET to the same secret used by the Vapi tool's x-anchorline-key header (minimum 32 characters).
Never commit secrets. Without persistent storage or authentication configured the process runs but refuses intake.
Use one replica with SQLite. Back up the volume and set an appropriate retention policy before production traffic.

## Vapi

Keep the existing assistant and submit_service_request schema. After `/readyz` returns HTTP 200, change the tool Server URL to `https://YOUR-RAILWAY-DOMAIN/vapi/webhook` and publish the tool.
The endpoint supports Vapi toolCallList and toolWithToolCallList envelopes and correlated string results. Phone intake is deduplicated per call ID. Dashboard chat uses a session ID when present, otherwise a chat ID, in a separate namespace. Corrections after a save do not create another request within that identity.
It does not book appointments, dispatch, or promise callbacks. Live transfer is limited to urgent jobs (see below).

## Optional receipts

Set RESEND_API_KEY, EMAIL_FROM (verified sender), and OFFICE_EMAIL in Railway.
Email is sent only after the record is committed; caller email requires email_confirmed:true.
Missing email configuration returns needs_review for a requested caller receipt, never accepted.
Test calls (is_test:true) are saved but never send email. Provider acceptance does not guarantee delivery.
If a process stops during email delivery, status may remain pending; inspect before manually retrying to avoid duplicates.
Past Base44 records are not automatically migrated.

## Client alerts (v1.1)

Each client assistant gets its own alert route, so demo and test lines never alert a client. Set ALERT_ROUTES in Railway as JSON keyed by Vapi assistant ID:
`{"<assistantId>": {"business": "Maple Plumbing", "sms": ["+1..."], "email": ["office@..."], "alertTests": false}}`
SMS uses TELNYX_API_KEY and TELNYX_FROM (a 10DLC-registered Telnyx number). Email alerts use RESEND_API_KEY and EMAIL_FROM.
Requests starting with "URGENT -" are flagged in the alert. The caller ID is stored and used when no callback number was given.
The add_request_note tool appends a note to the saved request and sends an update alert.
To catch callers who hang up before a request is saved, set the assistant Server URL to this webhook with the x-anchorline-key header and enable the end-of-call-report server message. Calls of 10 seconds or more with a caller ID become a "Caller hung up" request. Shorter calls (the caller hung up during the greeting) become a "Caller hung up during greeting – (615) ... – call them back" lead on lines with an alert route, once per caller number per 30 minutes (v1.8).

## Emergency live transfer (v1.6)

Add `"transfer": "+1..."` (owner's cell, E.164) to a route in ALERT_ROUTES. For a saved URGENT job, submit_service_request returns `live_transfer: "available"` and the spoken alert call is held while Emma tries the owner.
Emma's transfer tool has no fixed destination, so Vapi sends `transfer-destination-request` to this webhook. The reply is a `warm-transfer-experimental` destination: the owner hears the saved job (name, address, issue, and a number) and must accept before the caller is connected. The number follows the same rule as the alert call, SMS and email (`callbackNumbers` in server.mjs): "Their callback number is X" only for a callback_phone Emma saved with `callback_read_back: true`; otherwise "They're calling from <caller ID>"; with neither, "There's no number for them and no caller ID, so check your email after the call." A caller ID counts as blocked (no caller ID) when it is empty, has under 7 digits (`anonymous`, `Restricted`, `sip:anonymous@…`), or is one of the placeholder numbers `+266696687`, `+1266696687`, `+7378742833`, `+86282452253`, `+8656696` or `+10000000000`. None of these has been seen on our Telnyx/Vapi lines yet (0 of 46 inbound calls checked on 2026-10-17 were blocked), so the list is from carrier documentation, not from our traffic. Voicemail, no answer or a decline returns the caller to Emma (`fallbackPlan.endCallEnabled: false`).
The held alert call goes out, once, when Emma calls `transfer_no_answer`, when the call ends without being forwarded, or after TRANSFER_FALLBACK_SECONDS (default 75) unless Vapi reports the call as forwarded. Only one transfer attempt per call; test calls transfer only when the route has `alertTests: true`.
Add `transfer-destination-request` and `transfer-update` to the assistant's serverMessages.

## Urgent escalation, lock-screen subjects and daily digest (v1.8)

Route fields (ALERT_ROUTES; all optional):
`{"<assistantId>": {"business": "...", "email": ["office@..."], "call": ["+1..."], "backup": "+1...", "digest": ["owner@..."], "alertTests": false}}`
- `backup` (E.164): rung when the urgent alert call to the `call` numbers is not answered.
- `digest`: `false` turns the daily digest off; a list adds recipients to `email` for the digest only.

Urgent jobs: about 150 s after the spoken alert call is placed, the server asks Vapi (`GET /call/<id>`, VAPI_API_KEY) how it ended. Only `assistant-ended-call`, `assistant-said-end-call-phrase`, or `customer-ended-call` after 15 s or more counts as answered; no answer, busy, voicemail, silence timeout, max duration, a refused call, an error, or no result after 10 minutes count as not answered. Not answered: an `UNANSWERED URGENT – <issue> – <street> – <phone>` email goes to the route's `email` (and OFFICE_EMAIL), the `backup` number is rung, and the `call` numbers are rung once more about 5 minutes after the first ring (skipped if the backup answered). If Vapi does send the alert call's own end-of-call report to this webhook, its outcome is used directly and it never becomes a hang-up lead. Every ring and outcome is logged (`alert-call`, `alert-outcome`, `escalation`) and kept in SQLite (`alert_calls`, `escalations`), so restarts resume where they stopped. Test calls never ring, so they never escalate.

Owner emails have lock-screen subjects, at most 90 characters: `URGENT – burst pipe – 1412 Dickerson Pike – (615) 555-0142`, `New job – water heater quote – <street> – <phone>`, `Caller hung up – <phone> – call them back`. Bodies are unchanged, plus a `Recording:` line near the top when Vapi's end-of-call report carried a recording link (hang-up leads and the unanswered email; job alerts go out during the call, before a recording exists).

Daily digest: from 7am America/Chicago each route's `email` (plus `digest`) gets yesterday's calls Emma answered, jobs saved, urgent jobs with how their alert calls went, and hang-ups to call back, also on a zero-call day ("Emma answered 0 forwarded calls yesterday — she's on and working"). Trial clients in service get it too. Sent once per route per day (table `digests`; up to 5 tries, 15 minutes apart); a server that is down at 7 sends it later that day. Call counts need the end-of-call-report server message on the assistant (calls are logged in `call_log`).

## Verification

Run `npm test`. `/healthz` checks process/database health, `/readyz` checks storage and webhook authentication configuration. Neither endpoint reveals records or credentials.
Service requests are stored in requests.sqlite on the mounted volume; use controlled Railway console access to inspect or export them. There is no unauthenticated record API.

## Test data isolation (v1.6)

Every request row now has `assistant_id` and `is_test` columns (existing databases are migrated on start; old chat-session rows are marked as tests). Both are VIRTUAL generated columns read from the `details` JSON, so the table still stores 5 columns and a rollback to v1.5.0 keeps saving requests. Write test flags into `details`, never into these columns.
A request is a test, stored but never alerting a client or emailing a caller, when any of these match (`details.test_reason` records which):
- the receptionist set `is_test` (caller said "this is a test call");
- it came from a dashboard chat/session (Emma takes live jobs by phone only);
- the assistant is listed in `TEST_ASSISTANT_IDS` (comma-separated; demo or staging assistants);
- the caller ID or callback number is listed in `TEST_CALLER_NUMBERS` (comma-separated; e.g. Jake's phone and the voicetest caller line).
`GET /admin/requests/summary` with the `x-anchorline-key` header returns counts by assistant and test flag (no caller details).
Live reports and exports should filter `WHERE is_test = 0`.
