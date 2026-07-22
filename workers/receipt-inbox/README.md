# Receipt inbox Worker

Forward vendor receipts to one dedicated high-entropy address on a dedicated
Cloudflare-routed subdomain, for example
`receipts-secret-123@receipts.jays.services`. Cloudflare Email Routing sends
that exact address to this Worker. Do **not** onboard or change the apex
`jays.services` MX records: they continue delivering to iCloud.
The Worker stores each complete MIME message in a private R2 bucket and keeps a
chronological, transactional review index in a Durable Object. It exposes only
bounded, non-content metadata to Usage Monitor. This Worker never receives the
billing-receipt ingest token, billing identity key, or billing HMAC signing key
and cannot create a money event.

Every admitted email is first forwarded to a verified private fallback mailbox.
That copy preserves the original even if lifecycle verification, MIME parsing,
R2, or the index fails. Receipt processing remains explicit: the dashboard only
shows a needs-review item; it does not turn email into spend automatically.

Required public intake Worker secrets:

- `RECEIPT_INBOX_IDENTITY_KEY` — stable 32+ character HMAC key used only to
  derive a non-reversible, repeatable evidence ID.
- `RECEIPT_INBOX_READ_TOKEN` — 32+ character bearer token for the sanitized
  summary endpoint.
- `RECEIPT_INBOX_EVIDENCE_TOKEN` — separate 32+ character operator token for
  downloading an unreviewed `.eml`; never configure this token in Render.
- `RECEIPT_INBOX_ADDRESS` — exact high-entropy recipient on one
  `<subdomain>.jays.services` address, for example
  `receipts-secret-123@receipts.jays.services`. The handler rejects the apex
  domain and every other address before reading its MIME stream.
- `RECEIPT_INBOX_RETENTION_ACK` — set exactly to
  `receipt-evidence-lifecycle-configured-v1` only after the 180-day R2 lifecycle
  rule below is confirmed.
- `RECEIPT_FALLBACK_ADDRESS` — a private, Cloudflare-verified destination. The
  Worker forwards each admitted original here before parsing or storage work.

Required private lifecycle-auditor Worker secrets:

- `CLOUDFLARE_ACCOUNT_ID` — the exact 32-hex account containing the bucket.
- `RECEIPT_LIFECYCLE_AUDIT_TOKEN` — a distinct token with Cloudflare's
  account-scoped **Workers R2 Storage Read** permission. Cloudflare does not
  offer configuration-only R2 lifecycle scope: this permission can read/list
  R2 objects across the account. It is therefore bound only to the no-route,
  `workers_dev=false` auditor and never to the public intake Worker or Render.

Provision/deploy, then onboard only the dedicated receipt subdomain in
Cloudflare Email Routing (not the apex) and attach the exact address:

```bash
npm exec -- wrangler r2 bucket create usage-monitor-receipts
npm exec -- wrangler r2 bucket lifecycle add usage-monitor-receipts receipt-retention evidence/ --expire-days 180
npm run receipt-inbox:verify-lifecycle
npm exec -- wrangler secret put RECEIPT_INBOX_IDENTITY_KEY --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_INBOX_READ_TOKEN --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_INBOX_EVIDENCE_TOKEN --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_INBOX_ADDRESS --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_INBOX_RETENTION_ACK --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_FALLBACK_ADDRESS --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put CLOUDFLARE_ACCOUNT_ID --config workers/receipt-lifecycle-auditor/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_LIFECYCLE_AUDIT_TOKEN --config workers/receipt-lifecycle-auditor/wrangler.jsonc
npm run receipt-inbox:deploy
npm exec -- wrangler email routing rules create receipts.jays.services --name usage-monitor-receipts \
  --match-type literal --match-field to --match-value <high-entropy-address>@receipts.jays.services \
  --action-type worker --action-value usage-monitor-receipt-inbox
```

Confirm the exact current CLI flags with `wrangler email routing rules create
--help` before applying the final rule. Confirm the routing domain is
`receipts.jays.services` (or another dedicated subdomain), never
`jays.services`. Usage Monitor uses the fixed
`https://receipt-inbox.jays.services/v1/receipts/summary` endpoint; configure
Render with only the summary-read token. The handler fails closed unless the
retention acknowledgement and fallback are present. Every deploy re-checks the
live lifecycle rule. A SQLite-backed Durable Object transaction admits at most
100 delivery attempts and 100 MiB per UTC day before raw buffering or MIME
parsing; over-quota email is rejected without forwarding or reading the body.

The isolated auditor re-reads the exact lifecycle rule through Cloudflare's API
every 12 hours and stores the result in its own Durable Object. Intake also asks
it for a fresh audit when local readiness state reaches 24 hours. Readiness
fails closed if the audit is stale, if a conflicting enabled delete rule
overlaps `evidence/`, or if the exact 180-day rule is missing. The same exact
parser gates deployment. The auditor is deployed first, so the intake service
binding never has a missing target.

Both `/health` and the sanitized summary endpoint require the summary-read
token, so unauthenticated probes cannot generate R2/Durable Object reads.

After fallback forwarding, intake is recoverable across R2/index partial
failures: the index first creates
a non-visible `pending` reservation, the Worker writes evidence idempotently,
and a second transaction commits the visible review row. A retry resumes a
pending reservation. Pending rows expire after one day; committed review,
dedupe, sender-domain, and group metadata expire after 180 days in step with the
R2 evidence lifecycle. Durable Object alarms perform cleanup even when no mail
or dashboard request arrives; readiness fails closed while a cleanup backlog
remains. Summary results include committed, unexpired rows only.

An operator can download one unreviewed message for offline review without
giving Usage Monitor access to message content:

```bash
curl --fail --location --output receipt.eml \
  --header "Authorization: Bearer $RECEIPT_INBOX_EVIDENCE_TOKEN" \
  "https://<worker-host>/v1/receipts/<64-hex-id>/evidence"
```

After review, remove the item from the pending count while retaining evidence
until lifecycle expiry:

```bash
curl --fail --request PATCH \
  --header "Authorization: Bearer $RECEIPT_INBOX_EVIDENCE_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"status":"reviewed"}' \
  "https://receipt-inbox.jays.services/v1/receipts/<64-hex-id>/status"
```
