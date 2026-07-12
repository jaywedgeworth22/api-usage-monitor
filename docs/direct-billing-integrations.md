# Direct billing and account integrations

Last verified: 2026-07-12. Links below are provider-owned documentation.

## Data model and safety boundary

Adapters return two independent channels:

- `totalCost` is only actual provider-reported spend with an explicit window/scope. Budget math carries the latest compatible non-null current-month value through partial polls, excludes prior-month/daily windows, and accepts a billing-cycle total only when that cycle began in the current UTC month. When a total includes a known fixed plan fee, the adapter also reports `fixedCostIncludedUsd`.
- `externalBilling` is authoritative plan, status, billing-period, renewal, price, and limit metadata from an official API. It is idempotently reconciled into `ProviderExternalBilling` by `(providerId, source, externalId)`. Service-level rows can carry `serviceName`, used/remaining quantity, unit, a date semantic (`renewal`, `period_end`, `quota_reset`, `contract_end`, or `report_through`), and a `canonical`/`component`/`metadata` rollup role so breakdowns never masquerade as additional totals.

External billing rows are deliberately **not** copied into local `Subscription` rows. A local Subscription materializes a charge event; a provider-reported fixed charge is treated as distinct by default, even when the amounts happen to match. In Settings, an operator can link a local Subscription to the exact provider identity `(source, externalId)`. Budget math dedupes only the materialized amount proven by that explicit identity plus matching amount/cadence; ambiguous manual/provider fixed sources remain additive and raise `fixed_cost_conflict` instead of silently undercounting an unrelated add-on.

Push/manual adapters never send an inference, email, or market-data request merely to validate a credential. Twelve Data is the documented exception: `/api_usage` itself consumes one credit, so new Twelve Data connections default to daily rather than hourly polling. Dynamic endpoints are HTTPS-only, redirect-denied, DNS-pinned, private-address-blocked, and response-size-bounded. Pinecone-discovered data-plane hosts must also match a Pinecone-controlled `*.svc.*.pinecone.io` host before the API key is forwarded.

Credential-shaped provider configuration is stored in encrypted `Provider.secretConfig`. `config.adminApiKey`, `managementKey`, `apiKeySid`, `authUsername`, `apiSecret`, `secretKey`, tokens, passwords, authorization headers, and `extraHeaders` are decrypted only inside the adapter registry. Legacy browser-sync cookie/localStorage/sessionStorage containers are immediately redacted from API responses and scrubbed by the provider-secret migration because adapters do not need them. Provider API responses return only public config and safe `secretConfigMeta` field names.

Authoritative feeds reconcile only after their complete response has been validated. Stripe and Anthropic reject missing/repeated cursors and malformed successful responses; Cloudflare requires consistent `result_info` totals across the complete subscription list; GitHub, Vercel, and Cloudflare PayGo reject malformed HTTP 200 shapes. A partial or ambiguous response books no partial cost and cannot delete previously reconciled state. OpenAI retains only aggregate/page-count diagnostics for Costs API pages, never the full cost payload.

## Direct cost and billing connections implemented

| Provider | Direct data | Required credential/config | Official source |
|---|---|---|---|
| OpenAI | Organization Costs API plus legacy month-range usage/balance fallback; the one-day usage cost remains diagnostic-only | Organization Admin key in encrypted `adminApiKey`; normal API key remains separate | [Costs API](https://platform.openai.com/docs/api-reference/usage/costs) |
| Anthropic | Organization month-to-date cost report; cents converted to USD | Admin API key (`sk-ant-admin...`) in encrypted `adminApiKey` or primary key field | [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) |
| DeepSeek | Prepaid/granted balance and availability | API key | [User balance API](https://api-docs.deepseek.com/api/get-user-balance/) |
| xAI | Prepaid balance, postpaid current invoice preview, billing cycle, monthly spending limits | `teamId`; encrypted `managementKey` (or primary key if it is a Management API key) | [Billing Management API](https://docs.x.ai/developers/rest-api-reference/management/billing) |
| Mistral | Organization current usage/cost, payment/limit status, monthly spend cap, request/token limits | Backoffice Admin API key in encrypted `adminApiKey` | [Admin usage metrics](https://docs.mistral.ai/admin/admin-api/usage-metrics) |
| Cloudflare | Fixed account subscriptions plus billing-grade PayGo contracted cost for the current billing period (restricted alpha); analytics remains usage-only | `accountId`; API token with Billing Read, or encrypted global key plus `accountEmail` | [Account subscriptions](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/) and [PayGo billable usage](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/paygo) |
| Twilio | Account balance, canonical ThisMonth `totalprice`, and paginated product/category quantity and estimated-price breakdown | `accountId` (Account SID); auth token, or restricted-key secret in the primary key field plus encrypted `apiKeySid`/`authUsername` with `/twilio/billing/usage/read` | [Usage Records API](https://www.twilio.com/docs/usage/api/usage-record) |
| Apify | Billing cycle, usage USD, maximum usage, active plan, monthly base price and included credits; base + usage above included credits is canonical only when the reported cycle starts in the current UTC month | API token | [Account limits API](https://docs.apify.com/api/v2/users-me-limits-get) and [account API](https://docs.apify.com/api/v2/users-me-get) |
| Stripe | Available merchant balance and actual month-to-date fees with native-currency and reporting-category breakdowns | Restricted/secret key able to read Balance and Balance Transactions | [Balance](https://docs.stripe.com/api/balance) and [Balance Transactions](https://docs.stripe.com/api/balance_transactions/list) |
| GitHub | Organization enhanced-billing usage; sums `netAmount` without retaining repository-level details | `org`; fine-grained token with Organization Administration read | [Billing usage API](https://docs.github.com/en/rest/billing/usage) |
| Vercel | Month-to-date FOCUS 1.3 billing charges; sums `BilledCost` and stores service-level aggregates without project tags | Access token with billing access; optional `teamId`; Pro/Enterprise availability | [FOCUS billing charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges) |

Stripe customer subscriptions are merchant revenue, not the cost of the Stripe account. They are never treated as provider spend. Pending merchant balance is also not spend; only the `fee` on balance transactions feeds `totalCost`.

## Direct plan, status, quota, or run-rate connections implemented

These APIs are useful direct replacements for manually typed status/limits, but do not expose an authoritative invoice cost. Their plan/limit state is first-class `externalBilling`; it does not enter budget spend.

| Provider | Direct state | Boundary | Official source |
|---|---|---|---|
| Render | Service plan and suspended/active status (`serviceId`) | Service API has no invoice amount/cadence, so no cost is invented | [Retrieve service](https://api-docs.render.com/reference/retrieve-service) and [service fields](https://api-docs.render.com/reference/service-fields) |
| Hetzner Cloud | Server type, status, location and provider-published monthly plan run-rate per server in the project owner's actual `/pricing` currency | Resource prices are not accrued invoice cost; non-USD amounts are never relabeled or added to USD spend | [Cloud API](https://docs.hetzner.cloud/reference/cloud) |
| Twelve Data | Current plan body plus real-time credits used/remaining from documented response headers | No billing price or renewal API; `/api_usage` consumes one credit, so new connections default to daily sync | [API usage endpoint](https://twelvedata.com/docs/advanced/api-usage) |
| Intrinio | Per-feed current usage, limit, remaining calls and reset window | No subscription price/invoice API | [Current usage](https://docs.intrinio.com/documentation/web_api/get_account_current_usage_v2) |
| Pushover | Pooled account/team monthly message limit, remaining messages and reset | Since May 1, 2026 the allowance is pooled rather than per-application; price/status remain unavailable | [Application limits](https://pushover.net/api) |
| Tradier | Documented API rate-limit allowed/used/available/reset plus brokerage account status | Portfolio P/L and buying power are not API spend; they remain account metadata | [Rate limiting](https://docs.tradier.com/docs/rate-limiting) |
| Sentry | Organization event/transaction consumption summary | No documented account billing/subscription endpoint | [Organizations API](https://docs.sentry.io/api/organizations/) |
| Pinecone | Read-only index inventory, capacity mode/region/status, and vector count using the required `2026-04` API version | No public billing endpoint; discovered hosts are allowlisted before credential forwarding | [Usage reports and billing](https://docs.pinecone.io/guides/organizations/manage-billing/download-usage-report) |
| Resend | Non-sending API-key control-plane authentication plus API request-rate limit/remaining/reset headers | Request-rate headers are not the email plan's monthly send quota; plan price/renewal remain dashboard-only | [Rate limits](https://resend.com/docs/api-reference/rate-limit) |
| LlamaIndex Cloud | Non-inference project control-plane authentication | A beta usage-metrics API exists but is not connected yet; remaining credits, price, invoice, and renewal remain unavailable | [Usage metrics OpenAPI](https://api.cloud.llamaindex.ai/docs#/Beta/list_usage_metrics_api_v1_beta_usage_metrics_get) |
| Google Gemini API | Non-inference models control-plane authentication and any returned rate-limit headers | Gemini API key does not grant Cloud Billing cost access | [Gemini billing](https://ai.google.dev/gemini-api/docs/billing) |
| Alpaca | Brokerage account equity/status | Buying power/equity is not API credit or provider spend | [Trading API account](https://docs.alpaca.markets/reference/getaccount-1) |

Langfuse's metrics API reports the cost of model calls observed by Langfuse, not the Langfuse subscription invoice. The adapter exposes `trackedLlmCostUsd` as diagnostic metadata but does not book it against the Langfuse provider, avoiding double count with OpenAI/Anthropic/etc. See [Langfuse Metrics API](https://langfuse.com/docs/metrics/features/metrics-api).

Cloudflare analytics is not billing-grade. Fixed subscription prices/status are direct, and the restricted PayGo alpha supplies `ContractedCost` where the account is eligible. The broader v2 usage alpha currently documents cost fields as unpopulated, so the adapter does not infer missing cost from analytics.

## No safe direct billing endpoint found

The following adapters no longer consume a paid/quota-bearing product call for a fake “usage check.” They return a typed `UNSUPPORTED` result (no false successful snapshot) and rely on pushed telemetry or local Subscription/ProviderPlan data until the provider publishes a non-billable account API.

| Provider | Current authoritative surface |
|---|---|
| Voyage AI | Dashboard only; inference endpoints would create billable embeddings. [Pricing](https://docs.voyageai.com/docs/pricing) |
| FMP | Developer dashboard usage/billing. [Developer docs](https://site.financialmodelingprep.com/developer/docs/quickstart) |
| Finnhub | Dashboard/contract; no documented billing endpoint. [API docs](https://finnhub.io/docs/api) |
| Alpha Vantage | Dashboard/plan; no documented account billing endpoint. [Documentation](https://www.alphavantage.co/documentation/) |
| Tiingo | Account dashboard; no documented account billing endpoint. [API docs](https://www.tiingo.com/documentation/general/overview) |
| Marketstack | Dashboard usage and plan. [FAQ](https://marketstack.com/faq) |
| Massive (Polygon) | Account/billing dashboard. [Account help](https://massive.com/knowledge-base/categories/account) |
| Fintech Studios | No documented account usage/billing endpoint found |
| FRED | Free API; no billing state. [API docs](https://fred.stlouisfed.org/docs/api/fred/) |
| Robinhood retail | No public retail subscription/billing API |

Google Cloud cost data can be automated only through a separate Cloud Billing/BigQuery billing-export integration using Google Cloud identity and a billing project; a Gemini API key is intentionally insufficient. Pinecone usage reports are downloadable CSVs in the console rather than a documented API. Render and Hetzner expose resource plan/state but not invoices. Those boundaries are kept explicit instead of scraping dashboards or storing interactive-login credentials.

## Operations

- `npm run migrate:provider-secrets` is dry-run by default; add `-- --apply` only after a database backup and schema deployment. It reports field paths, never values, encrypts supported credentials, and removes obsolete browser-session/storage payloads left by the retired browser-sync path.
- `npm run audit:provider-duplicates` is read-only and prints only normalized provider names and IDs. Duplicate rows are warned in provider GET responses but are never auto-merged/deleted because each may own different credentials, plans, snapshots, subscriptions, or project allocations.
- `npm run audit:subscription-links` is read-only and blocks startup before the new unique link index is applied when one provider billing identity is attached to multiple local subscriptions. After a clean audit, startup creates that exact index directly, then runs ordinary `prisma db push`; it never enables Prisma's broad `--accept-data-loss` bypass. Resolve duplicates only after the startup-created SQLite backup is verified; the app never guesses which materialized charge to delete.
- Schema deployment adds the service/quota/rollup/date fields to `ProviderExternalBilling` and creates `Provider.secretConfig` through the existing additive-only `scripts/migrate-safe.mjs` startup path.
