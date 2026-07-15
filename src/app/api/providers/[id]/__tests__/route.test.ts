import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

let testDir: string;
let PUT: typeof import("../route").PUT;
let GET: typeof import("../route").GET;
let GET_COLLECTION: typeof import("../../route").GET;
let prisma: typeof import("@/lib/prisma").prisma;
let encryptJson: typeof import("@/lib/crypto").encryptJson;
let decryptJson: typeof import("@/lib/crypto").decryptJson;
let encrypt: typeof import("@/lib/crypto").encrypt;
let geminiApiKeyFingerprint: typeof import("@/lib/gemini-key-status").geminiApiKeyFingerprint;
let geminiBillingConfigFingerprint: typeof import("@/lib/gemini-key-status").geminiBillingConfigFingerprint;
let geminiMonitoringConfigFingerprint: typeof import("@/lib/gemini-key-status").geminiMonitoringConfigFingerprint;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-route-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "33".repeat(32);
  setupPrismaSqliteTestDb(dbPath);

  ({ GET, PUT } = await import("../route"));
  ({ GET: GET_COLLECTION } = await import("../../route"));
  ({ prisma } = await import("@/lib/prisma"));
  ({ encrypt, encryptJson, decryptJson } = await import("@/lib/crypto"));
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

function updateRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`https://usage.jays.services/api/providers/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/providers/:id secret config operations", () => {
  it("disconnects Google billing while preserving unrelated public and secret config", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        refreshIntervalMin: 60,
        config: {
          billingDataset: "billing-project.billing_export",
          googleProjectId: "gemini-production",
          billingTable: "gcp_billing_export_v1_ABC",
          statusKeyRef: "gemini-primary",
        },
        secretConfig: encryptJson({
          serviceAccountJson: "service-account-secret",
          adminApiKey: "unrelated-admin-secret",
          nested: { password: "unrelated-nested-secret" },
        }),
      },
    });

    const response = await PUT(
      updateRequest(provider.id, {
        config: { statusKeyRef: "gemini-primary" },
        secretConfigOperations: [
          { path: ["serviceAccountJson"], action: "clear" },
        ],
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
      select: {
        config: true,
        secretConfig: true,
        alertConfigGeneration: true,
      },
    });
    expect(stored.config).toEqual({ statusKeyRef: "gemini-primary" });
    expect(decryptJson(stored.secretConfig!)).toEqual({
      adminApiKey: "unrelated-admin-secret",
      nested: { password: "unrelated-nested-secret" },
    });
    expect(stored.alertConfigGeneration).toBe(1);
  });

  it("can clear the service account without replacing public config", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        refreshIntervalMin: 60,
        config: { billingDataset: "billing-project.billing_export" },
        secretConfig: encryptJson({
          serviceAccountJson: "service-account-secret",
          apiToken: "keep-token",
        }),
      },
    });

    const response = await PUT(
      updateRequest(provider.id, {
        secretConfigOperations: [
          { path: ["serviceAccountJson"], action: "clear" },
        ],
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
      select: {
        config: true,
        secretConfig: true,
        alertConfigGeneration: true,
      },
    });
    expect(stored.config).toEqual({
      billingDataset: "billing-project.billing_export",
    });
    expect(decryptJson(stored.secretConfig!)).toEqual({ apiToken: "keep-token" });
    expect(stored.alertConfigGeneration).toBe(1);
  });

  it("increments the alert revision for API-key and config capability edits", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "anthropic",
        displayName: "Anthropic",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });

    const apiKeyResponse = await PUT(
      updateRequest(provider.id, { apiKey: "sk-ant-admin01-primary-test" }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(apiKeyResponse.status).toBe(200);
    expect(
      await prisma.provider.findUniqueOrThrow({ where: { id: provider.id } })
    ).toMatchObject({ alertConfigGeneration: 1 });

    const configResponse = await PUT(
      updateRequest(provider.id, {
        config: { adminApiKey: "sk-ant-admin01-secondary-test" },
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );
    expect(configResponse.status).toBe(200);
    const stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
      select: { alertConfigGeneration: true, secretConfig: true },
    });
    expect(stored.alertConfigGeneration).toBe(2);
    expect(decryptJson(stored.secretConfig!)).toEqual({
      adminApiKey: "sk-ant-admin01-secondary-test",
    });
  });

  it("increments the alert revision atomically with alert-affecting provider edits", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "alert-revision",
        displayName: "Alert Revision",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { lowBalanceUsd: 10 } },
      },
    });

    const response = await PUT(
      updateRequest(provider.id, {
        isActive: false,
        refreshIntervalMin: 120,
        plan: { lowBalanceUsd: 5 },
      }),
      { params: Promise.resolve({ id: provider.id }) }
    );

    expect(response.status).toBe(200);
    const stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
      include: { plan: true },
    });
    expect(stored).toMatchObject({
      isActive: false,
      refreshIntervalMin: 120,
      alertConfigGeneration: 1,
      plan: { lowBalanceUsd: 5 },
    });
  });
});

describe("GET /api/providers/:id Gemini key status", () => {
  it("returns sanitized current-key health without exposing snapshot raw data", async () => {
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
          create: {
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
                configFingerprint:
                  geminiBillingConfigFingerprint(billingConfig),
                privateBillingPayload: "must-not-be-returned",
              },
              monitoring: {
                configured: true,
                status: "permission_denied",
                projectId: "gemini-production",
                configFingerprint:
                  geminiMonitoringConfigFingerprint(billingConfig),
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
        },
        externalBilling: {
          create: [
            {
              source: "google-cloud-billing-export",
              externalId: "gemini-mtd:prior-config",
              kind: "billing_period",
              serviceName: "Gemini API",
              status: "active",
              amountUsd: 91.25,
              currency: "USD",
              syncedAt: new Date("2026-07-14T22:00:00.000Z"),
            },
            {
              source: "google-gemini-rate-limits",
              externalId: "gemini-api-key",
              kind: "account",
              planName: "Gemini API quota",
              status: "active",
              requestLimit: 100,
              syncedAt: new Date("2026-07-14T22:00:00.000Z"),
            },
          ],
        },
      },
    });
    // Pushed quota/credit status creates a newer snapshot without adapter
    // rawData; it must remain the latest chart row without erasing the last
    // credential/billing check.
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: new Date("2026-07-14T23:05:00.000Z"),
        totalRequests: 123,
      },
    });

    const response = await GET(
      new NextRequest(
        `https://usage.jays.services/api/providers/${provider.id}`
      ),
      { params: Promise.resolve({ id: provider.id }) }
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.geminiKeyStatus).toEqual({
      state: "valid",
      httpStatus: 200,
      availableModelCount: 50,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(body.geminiBillingStatus).toEqual({
      state: "pending",
      errorCode: null,
      httpStatus: null,
      retryable: false,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(body.geminiMonitoringStatus).toEqual({
      state: "permission_denied",
      projectId: "gemini-production",
      errorCode: "HTTP_ERROR",
      httpStatus: 403,
      retryable: false,
      checkedAt: "2026-07-14T23:00:00.000Z",
    });
    expect(body.latestSnapshot.fetchedAt).toBe("2026-07-14T23:05:00.000Z");
    expect(body.latestSnapshot.totalRequests).toBe(123);
    expect(body.latestSnapshot).not.toHaveProperty("rawData");
    expect(body.externalBilling).toEqual([
      expect.objectContaining({
        source: "google-gemini-rate-limits",
        externalId: "gemini-api-key",
      }),
    ]);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain("must-not-be-returned");
    expect(serialized).not.toContain(geminiApiKeyFingerprint(apiKey));
    expect(serialized).not.toContain(
      geminiMonitoringConfigFingerprint(billingConfig)
    );

    const collectionResponse = await GET_COLLECTION();
    const collectionBody = await collectionResponse.json();
    const collectionSerialized = JSON.stringify(collectionBody);
    const collectionProvider = collectionBody.find(
      (entry: { id?: unknown }) => entry.id === provider.id
    );
    expect(collectionResponse.status).toBe(200);
    expect(collectionSerialized).not.toContain(
      geminiMonitoringConfigFingerprint(billingConfig)
    );
    expect(collectionProvider.externalBilling).toEqual([
      expect.objectContaining({
        source: "google-gemini-rate-limits",
        externalId: "gemini-api-key",
      }),
    ]);
  });
});

describe("GET /api/providers alert visibility", () => {
  it("keeps budget alerts visible without snapshot noise for blind providers", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "fmp",
        displayName: "FMP",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: {
          create: {
            billingMode: "actual",
            fixedMonthlyCostUsd: 15,
            monthlyBudgetUsd: 10,
          },
        },
      },
    });

    const detailResponse = await GET(
      new NextRequest(
        `https://usage.jays.services/api/providers/${provider.id}`
      ),
      { params: Promise.resolve({ id: provider.id }) }
    );
    const detailBody = await detailResponse.json();

    expect(detailResponse.status).toBe(200);
    expect(detailBody.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "budget_exceeded" }),
      ])
    );
    expect(detailBody.alerts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_snapshot" }),
      ])
    );

    const collectionResponse = await GET_COLLECTION();
    const collectionBody = await collectionResponse.json();
    const collectionProvider = collectionBody.find(
      (entry: { id?: unknown }) => entry.id === provider.id
    );

    expect(collectionResponse.status).toBe(200);
    expect(collectionProvider.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "budget_exceeded" }),
      ])
    );
    expect(collectionProvider.alerts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_snapshot" }),
      ])
    );
  });
});
