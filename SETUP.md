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
The endpoint supports Vapi toolCallList and toolWithToolCallList envelopes, correlated string results, and one saved request per call ID. Corrections after a save do not create another request.
It does not book appointments, dispatch, transfer, or promise callbacks.

## Optional receipts

Set RESEND_API_KEY, EMAIL_FROM (verified sender), and OFFICE_EMAIL in Railway.
Email is sent only after the record is committed; caller email requires email_confirmed:true.
Missing email configuration returns needs_review for a requested caller receipt, never accepted.
Test calls (is_test:true) are saved but never send email. Provider acceptance does not guarantee delivery.
If a process stops during email delivery, status may remain pending; inspect before manually retrying to avoid duplicates.
Past Base44 records are not automatically migrated.

## Verification

Run `npm test`. `/healthz` checks process/database health, `/readyz` checks storage and webhook authentication configuration. Neither endpoint reveals records or credentials.
Service requests are stored in requests.sqlite on the mounted volume; use controlled Railway console access to inspect or export them. There is no unauthenticated record API.
