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
To catch callers who hang up before a request is saved, set the assistant Server URL to this webhook with the x-anchorline-key header and enable the end-of-call-report server message. Calls of 10 seconds or more with a caller ID become a "Caller hung up" request.

## Emergency live transfer (v1.6)

Add `"transfer": "+1..."` (owner's cell, E.164) to a route in ALERT_ROUTES. For a saved URGENT job, submit_service_request returns `live_transfer: "available"` and the spoken alert call is held while Emma tries the owner.
Emma's transfer tool has no fixed destination, so Vapi sends `transfer-destination-request` to this webhook. The reply is a `warm-transfer-experimental` destination: the owner hears the saved job (name, address, issue, callback number) and must accept before the caller is connected. Voicemail, no answer or a decline returns the caller to Emma (`fallbackPlan.endCallEnabled: false`).
The held alert call goes out, once, when Emma calls `transfer_no_answer`, when the call ends without being forwarded, or after TRANSFER_FALLBACK_SECONDS (default 75) unless Vapi reports the call as forwarded. Only one transfer attempt per call; test calls transfer only when the route has `alertTests: true`.
Add `transfer-destination-request` and `transfer-update` to the assistant's serverMessages.

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
