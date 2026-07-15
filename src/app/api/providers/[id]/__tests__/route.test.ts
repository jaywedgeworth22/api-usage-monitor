import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

let testDir: string;
let PUT: typeof import("../route").PUT;
let prisma: typeof import("@/lib/prisma").prisma;
let encryptJson: typeof import("@/lib/crypto").encryptJson;
let decryptJson: typeof import("@/lib/crypto").decryptJson;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-route-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "33".repeat(32);
  setupPrismaSqliteTestDb(dbPath);

  ({ PUT } = await import("../route"));
  ({ prisma } = await import("@/lib/prisma"));
  ({ encryptJson, decryptJson } = await import("@/lib/crypto"));
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
