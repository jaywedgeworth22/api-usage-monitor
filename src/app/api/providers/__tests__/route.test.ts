import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

// GET /api/providers is the dashboard's (and Settings/Connections') primary
// data source, polled on mount and on an interval. It previously selected
// each provider's latest snapshot WITH the full adapter rawData JSON blob
// (39 providers x large per-provider raw API payloads), plus ran the exact
// same full-provider-with-rawData query a SECOND time inside
// computeBudgetStatus(), plus a THIRD, differently-scoped rawData read via
// budget-status.ts's latestCostSnapshots, plus two serialized per-provider
// findFirst N+1 loops for Gemini status - all under the app's
// connection_limit=1 single SQLite connection. That combination of DB
// read/JSON-parse volume and query serialization is what OOM-crashed the
// 512MB Render instance. These tests guard the fix: the response must keep
// every field the client reads while no longer forcing a full rawData
// blob through the query/response pipeline for every provider.
let GET: typeof import("../route").GET;
let prisma: typeof import("@/lib/prisma").prisma;
let encrypt: typeof import("@/lib/crypto").encrypt;
let encryptJson: typeof import("@/lib/crypto").encryptJson;
let geminiApiKeyFingerprint: typeof import("@/lib/gemini-key-status").geminiApiKeyFingerprint;
let geminiBillingConfigFingerprint: typeof import("@/lib/gemini-key-status").geminiBillingConfigFingerprint;
let geminiMonitoringConfigFingerprint: typeof import("@/lib/gemini-key-status").geminiMonitoringConfigFingerprint;

let testDir: string;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "providers-list-route-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "44".repeat(32);
  setupPrismaSqliteTestDb(dbPath);

  ({ GET } = await import("../route"));
  ({ prisma } = await import("@/lib/prisma"));
  ({ encrypt, encryptJson } = await import("@/lib/crypto"));
  ({
    geminiApiKeyFingerprint,
    geminiBillingConfigFingerprint,
    geminiMonitoringConfigFingerprint,
  } = await import("@/lib/gemini-key-status"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  delete process.env.ENCRYPTION_KEY;
});

beforeEach(async () => {
  await prisma.provider.deleteMany();
});

describe("GET /api/providers - rawData exclusion and cost-coverage caveat", () => {
  it("never ships the rawData blob but still surfaces the derived costCoverageCaveat", async () => {
    // A ~60KB filler blob stands in for a real adapter's raw API response
    // (the thing that made this endpoint's DB read/response heavy at 39
    // providers). It must never reach the client.
    const secretMarker = "must-not-leave-the-server-boundary";
    const bigFiller = secretMarker.repeat(2000);

    const flagged = await prisma.provider.create({
      data: {
        name: "cloudflare",
        displayName: "Cloudflare",
        type: "builtin",
        refreshIntervalMin: 60,
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-16T12:00:00.000Z"),
            totalCost: 12.5,
            rawData: {
              filler: bigFiller,
              __apiUsageMonitor: {
                version: 1,
                costCoverageCaveat: {
                  code: "cloudflare_paygo_usage_unavailable",
                  message: "PayGo usage could not be reached; totalCost may be understated.",
                },
              },
            },
          },
        },
      },
    });

    const plain = await prisma.provider.create({
      data: {
        name: "openai",
        displayName: "OpenAI",
        type: "builtin",
        refreshIntervalMin: 60,
        snapshots: {
          create: {
            fetchedAt: new Date("2026-07-16T12:05:00.000Z"),
            totalCost: 4,
            totalRequests: 10,
            credits: null,
            balance: 7.5,
          },
        },
      },
    });

    const response = await GET();
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    // The marker (and thus the whole rawData blob it's embedded in) must
    // never appear in the response body.
    expect(serialized).not.toContain(secretMarker);
    // A sanity ceiling: two providers' worth of real response fields should
    // be a couple KB at most - nowhere near the 60KB+ the raw blob alone
    // would add if it leaked through.
    expect(serialized.length).toBeLessThan(20_000);

    const flaggedEntry = body.find((p: { id: string }) => p.id === flagged.id);
    const plainEntry = body.find((p: { id: string }) => p.id === plain.id);

    expect(flaggedEntry.costCoverageCaveat).toEqual({
      code: "cloudflare_paygo_usage_unavailable",
      message: "PayGo usage could not be reached; totalCost may be understated.",
    });
    expect(flaggedEntry.latestSnapshot).not.toHaveProperty("rawData");
    expect(flaggedEntry.latestSnapshot.totalCost).toBe(12.5);

    // No caveat metadata on this snapshot -> null, not a thrown error or a
    // leaked raw value.
    expect(plainEntry.costCoverageCaveat).toBeNull();
    expect(plainEntry.latestSnapshot).toMatchObject({
      balance: 7.5,
      totalCost: 4,
      totalRequests: 10,
      credits: null,
      fetchedAt: "2026-07-16T12:05:00.000Z",
    });
    expect(plainEntry.latestSnapshot).not.toHaveProperty("rawData");
    expect(plainEntry.latestSnapshot).not.toHaveProperty("id");
  });

  it("returns null costCoverageCaveat for a provider with no snapshot at all", async () => {
    const provider = await prisma.provider.create({
      data: { name: "fmp", displayName: "FMP", type: "builtin", refreshIntervalMin: 60 },
    });

    const response = await GET();
    const body = await response.json();
    const entry = body.find((p: { id: string }) => p.id === provider.id);

    expect(response.status).toBe(200);
    expect(entry.costCoverageCaveat).toBeNull();
    expect(entry.latestSnapshot).toBeNull();
  });
});

describe("GET /api/providers - batched Gemini status (no per-provider N+1)", () => {
  it("derives Gemini key/billing/monitoring status from the LATEST snapshot per provider, sanitized", async () => {
    const apiKey = "test-current-google-cloud-console-key";
    const billingConfig = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "gemini-production",
      serviceAccountJson: "test-service-account-json",
    };

    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        apiKey: encrypt(apiKey),
        config: {
          billingDataset: billingConfig.billingDataset,
          googleProjectId: billingConfig.googleProjectId,
        },
        secretConfig: encryptJson({
          serviceAccountJson: billingConfig.serviceAccountJson,
        }),
        refreshIntervalMin: 60,
        snapshots: {
          create: [
            // Older snapshot with a DIFFERENT (stale) key fingerprint - the
            // batched query must not accidentally pick this one.
            {
              fetchedAt: new Date("2026-07-14T20:00:00.000Z"),
              rawData: {
                keyValidation: {
                  ok: true,
                  status: 200,
                  availableModelCount: 1,
                  credentialFingerprint: "0".repeat(64),
                  upstreamBody: "must-not-be-returned",
                },
              },
            },
            // Latest snapshot with rawData - this is the one that must win.
            {
              fetchedAt: new Date("2026-07-14T23:00:00.000Z"),
              rawData: {
                keyValidation: {
                  ok: true,
                  status: 200,
                  availableModelCount: 50,
                  credentialFingerprint: geminiApiKeyFingerprint(apiKey),
                  upstreamBody: "must-not-be-returned",
                },
                billing: {
                  configured: true,
                  status: "pending",
                  configFingerprint: geminiBillingConfigFingerprint(billingConfig),
                  privateBillingPayload: "must-not-be-returned",
                },
                monitoring: {
                  configured: true,
                  status: "permission_denied",
                  projectId: "gemini-production",
                  configFingerprint: geminiMonitoringConfigFingerprint(billingConfig),
                  requests: {
                    status: "error",
                    errorCode: "HTTP_ERROR",
                    httpStatus: 403,
                    retryable: false,
                    upstreamBody: "must-not-be-returned",
                  },
                },
              },
            },
            // Newest snapshot of all, but with no rawData (e.g. a
            // quota/credit-only push) - must not erase the last real check.
            {
              fetchedAt: new Date("2026-07-14T23:05:00.000Z"),
              totalRequests: 123,
            },
          ],
        },
      },
    });

    // A second, unrelated non-Gemini provider makes sure the batched query's
    // providerId filter/dedup doesn't cross-contaminate between providers.
    await prisma.provider.create({
      data: { name: "anthropic", displayName: "Anthropic", type: "builtin", refreshIntervalMin: 60 },
    });

    const response = await GET();
    const body = await response.json();
    const serialized = JSON.stringify(body);
    const entry = body.find((p: { id: string }) => p.id === provider.id);

    expect(response.status).toBe(200);
    expect(entry.geminiKeyStatus).toEqual({
      state: "valid",
      httpStatus: 200,
      availableModelCount: 50,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(entry.geminiBillingStatus).toEqual({
      state: "pending",
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(entry.geminiMonitoringStatus).toEqual({
      state: "permission_denied",
      projectId: "gemini-production",
      errorCode: "HTTP_ERROR",
      httpStatus: 403,
      retryable: false,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(entry.latestSnapshot.fetchedAt).toBe("2026-07-14T23:05:00.000Z");
    expect(entry.latestSnapshot.totalRequests).toBe(123);
    expect(serialized).not.toContain("must-not-be-returned");
    expect(serialized).not.toContain(apiKey);
  });
});

describe("GET /api/providers - budget-status Gemini cost-identity quarantine (scoped rawData)", () => {
  it("quarantines a cost snapshot from a stale billing config, using only that snapshot's own rawData", async () => {
    // computeBudgetStatus() (called from this route) picks the "latest
    // snapshot with non-null rawData" for geminiBillingStatus and,
    // SEPARATELY, the "latest snapshot with a cost this month" for
    // geminiCostIdentityStatus - these can legitimately be two different
    // rows. budget-status.ts now fetches rawData for only that second,
    // cost-specific snapshot id (scoped to Gemini providers) instead of
    // selecting it for every provider's cost snapshot; this test proves
    // that scoping still finds and evaluates the RIGHT row.
    const currentConfig = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "gemini-current-project",
      serviceAccountJson: "current-service-account-json",
    };
    const staleConfig = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "gemini-old-project",
      serviceAccountJson: "old-service-account-json",
    };

    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        config: {
          billingDataset: currentConfig.billingDataset,
          googleProjectId: currentConfig.googleProjectId,
        },
        secretConfig: encryptJson({
          serviceAccountJson: currentConfig.serviceAccountJson,
        }),
        refreshIntervalMin: 60,
        snapshots: {
          create: [
            // The only cost-bearing snapshot this month - written under the
            // OLD billing configuration. This is what latestCostByProviderId
            // will pick for this provider.
            {
              fetchedAt: new Date("2026-07-10T00:00:00.000Z"),
              totalCost: 50,
              rawData: {
                billing: {
                  configured: true,
                  status: "ready",
                  configFingerprint: geminiBillingConfigFingerprint(staleConfig),
                },
              },
            },
            // A newer, non-cost-bearing snapshot under the CURRENT
            // configuration - this is what geminiStatusSnapshots (the
            // separate "latest any-rawData snapshot" query) will pick.
            {
              fetchedAt: new Date("2026-07-12T00:00:00.000Z"),
              rawData: {
                billing: {
                  configured: true,
                  status: "ready",
                  configFingerprint: geminiBillingConfigFingerprint(currentConfig),
                },
              },
            },
          ],
        },
      },
    });

    const response = await GET();
    const body = await response.json();
    const entry = body.find((p: { id: string }) => p.id === provider.id);

    expect(response.status).toBe(200);
    // The $50 from the stale-config snapshot must be quarantined out of
    // spend, not silently charged to the current configuration - proving
    // geminiCostIdentityStatus still correctly reads the SPECIFIC
    // cost-snapshot's rawData (fetched via the new scoped
    // geminiCostRawDataById lookup in budget-status.ts) rather than the
    // general "latest any-rawData snapshot" used for geminiBillingStatus
    // (which is left "ready" here on purpose, to isolate the two).
    expect(entry.snapshotCostUsd).toBeNull();
    expect(entry.spentUsd).toBe(0);
    expect(entry.spendCoverage).not.toBe("complete");
  });
});
