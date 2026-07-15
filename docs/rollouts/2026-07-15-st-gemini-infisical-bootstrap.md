# One-time ST Gemini Infisical bootstrap

## Scope

This is a one-time server-side migration, not bidirectional credential sync.
It can only consider Provider `4a888d41-3988-4774-86d8-67d7aa14d7e2` and can
only create the shared `GEMINI_API_KEY` at the Socratic.Trade Infisical project
`39d93bb7-76f9-498c-8b50-a7def52e072f`, environment `prod`, path `/`.

The bootstrap never updates or deletes an Infisical secret. The normal
Infisical-to-monitor pull remains the steady-state direction and binds the
newly created value after a successful bootstrap.

## Preconditions

- The fixed provider is active, builtin Google AI, allocated exactly 100% and
  exclusively to `SocraticTrade.com`, and has no CT/shared Infisical binding.
- Its latest successful Gemini key validation is at most 24 hours old and its
  server-only credential fingerprint matches the currently encrypted key.
- The ST Universal Auth credentials are configured.
- A value-disabled list preflight succeeds for the exact fixed scope, followed
  by an exact read proving `GEMINI_API_KEY` is missing.
- The provider generation and key fingerprint remain unchanged on the final
  re-read immediately before the create request.

Any failed or ambiguous precondition stops before creation. An existing equal
value is a no-op; an existing different value is a hard conflict. While the
one-time flag is enabled, every non-success bootstrap outcome also suppresses
only the ST Gemini mapping in the immediately following normal pull, so a
conflicting remote value cannot replace the validated monitor credential.
Other provider mappings continue to sync normally.

## Reviewed production procedure

1. Confirm a fresh successful provider validation and healthy provider polling.
2. Set only `INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED=true` on the Render service.
3. Observe the sanitized `[infisical-st-gemini-bootstrap]` result. It contains
   only provider ID, status, attempted, and an optional bounded error code.
4. Confirm status `created` or `already_present_same`, then confirm the normal
   one-way sync attached the ST Infisical binding without creating a duplicate.
5. Immediately set `INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED=false`.

For `conflict`, `ineligible`, or `error`, disable the flag and investigate.
Do not retry by PATCH/upsert and do not delete anything automatically.

The currently configured `agentic-trading` machine identity has broad project
Admin access and is permitted here only for this reviewed one-time bootstrap.
Follow-up hardening should give Usage Monitor a dedicated allowlisted ST reader
and use a separate temporary create-only writer for future migrations; do not
downgrade the application identity without first auditing Socratic.Trade's own
secret requirements.

## Rollback

Because the operation is create-only and leaves the monitor credential intact,
rollback is limited to an explicit administrator deleting the exact newly
created Infisical secret/version. The normal pull retains last-known-good
monitor credentials when a source becomes missing. If the pull already attached
the new ST binding, remove only that binding with the provider configuration
generation guard as a separate reviewed operation.
