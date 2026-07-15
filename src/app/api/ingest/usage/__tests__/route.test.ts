import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const externalUsageMocks = vi.hoisted(() => ({
  persist: vi.fn(),
  syncStatus: vi.fn(),
}));
const resolveProjects = vi.hoisted(() => vi.fn());
const providerFindMany = vi.hoisted(() => vi.fn());

vi.mock("@/lib/external-usage-events", () => ({
  ExternalUsageIdempotencyCollisionError: class extends Error {},
  persistExternalUsageEvents: externalUsageMocks.persist,
  syncStatusToUsageSnapshot: externalUsageMocks.syncStatus,
}));
vi.mock("@/lib/project-resolver", () => ({
  resolveProjectIdsByName: resolveProjects,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { provider: { findMany: providerFindMany } },
}));

import { POST } from "../route";
import { tryAcquireIngestAdmission } from "@/lib/ingest-admission";
import { signReceiptCashEvent } from "@/lib/receipt-cash";

const USAGE_TOKEN = "usage-test-token";
const RECEIPT_TOKEN = "receipt-test-token-distinct";
const RECEIPT_HMAC_KEY = "receipt-test-signing-key-long-enough";
const LOCAL_RECEIPT_TOKEN = "local-receipt-test-token-distinct";
const LOCAL_RECEIPT_HMAC_KEY = "local-receipt-test-signing-key-long-enough";
const RECEIPT_PROVIDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECEIPT_DIGEST = "b".repeat(64);
let ipCounter = 0;

function nextRequest(
  body: unknown,
  token: string,
  url = "https://usage.jays.services/api/ingest/usage"
): NextRequest {
  ipCounter += 1;
  return new NextRequest(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-forwarded-for": `10.1.0.${ipCounter}`,
    },
    body: JSON.stringify(body),
  });
}

function ordinaryRequest(token = USAGE_TOKEN): NextRequest {
  return nextRequest(
    {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "cost",
      costUsd: 0,
      occurredAt: "2026-07-14T00:00:00.000Z",
      idempotencyKey: "admission-test-event",
    },
    token
  );
}

function receiptEvent(
  overrides: Record<string, unknown> = {},
  signingKey = RECEIPT_HMAC_KEY
) {
  const event: Record<string, unknown> = {
    idempotencyKey: `billing-receipt:v1:${RECEIPT_DIGEST}`,
    sourceApp: "billing-receipt-import",
    provider: "anthropic",
    service: "api-prepaid-funding",
    label: "receipt_cash_paid",
    keyRef: `provider:${RECEIPT_PROVIDER_ID}:billing-receipt:${RECEIPT_DIGEST}`,
    billingMode: "actual",
    metricType: "cost",
    unit: "usd",
    confidence: "actual",
    costUsd: 47.25,
    occurredAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
  const digestMatch = /billing-receipt:([0-9a-f]{64})$/i.exec(String(event.keyRef));
  const digest = digestMatch?.[1] ?? RECEIPT_DIGEST;
  const providerIdMatch = /^provider:([^:]+):billing-receipt:/i.exec(String(event.keyRef));
  const providerId = providerIdMatch?.[1] ?? RECEIPT_PROVIDER_ID;
  const signature = signReceiptCashEvent(
    {
      providerId,
      providerName: String(event.provider),
      digest,
      amountUsd: Number(event.costUsd),
      occurredAt: String(event.occurredAt),
    },
    signingKey
  );
  event.metadata = {
    schemaVersion: 1,
    costSemantics: "receipt_cash_paid",
    receiptKind: "api_prepaid_funding",
    evidenceRef: `hmac-sha256:${digest}`,
    receiptSignature: `hmac-sha256:${signature}`,
    ...((overrides.metadata as Record<string, unknown> | undefined) ?? {}),
  };
  return event;
}

function receiptRequest(
  overrides: Record<string, unknown> = {},
  token = RECEIPT_TOKEN,
  url = "https://usage.jays.services/api/ingest/usage",
  signingKey = RECEIPT_HMAC_KEY
): NextRequest {
  return nextRequest(receiptEvent(overrides, signingKey), token, url);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("USAGE_INGEST_TOKEN", USAGE_TOKEN);
  vi.stubEnv("BILLING_RECEIPT_INGEST_TOKEN", RECEIPT_TOKEN);
  vi.stubEnv("BILLING_RECEIPT_HMAC_KEY", RECEIPT_HMAC_KEY);
  resolveProjects.mockResolvedValue(new Map());
  externalUsageMocks.persist.mockResolvedValue({
    attempted: 1,
    persisted: 1,
    skippedPrunedDuplicates: 0,
    newEvents: [],
  });
  externalUsageMocks.syncStatus.mockResolvedValue(undefined);
  providerFindMany.mockResolvedValue([
    { id: RECEIPT_PROVIDER_ID, name: "anthropic" },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/ingest/usage admission", () => {
  it("rejects an overlapping writer before any database helper runs", async () => {
    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    try {
      const response = await POST(ordinaryRequest());
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(resolveProjects).not.toHaveBeenCalled();
      expect(externalUsageMocks.persist).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it("releases admission after a successful ingest", async () => {
    const response = await POST(ordinaryRequest());
    expect(response.status).toBe(202);

    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });

  it("reports zero accepted rows for an idempotent replay", async () => {
    externalUsageMocks.persist.mockResolvedValueOnce({
      attempted: 1,
      persisted: 0,
      skippedPrunedDuplicates: 0,
      newEvents: [],
    });

    const response = await POST(ordinaryRequest());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      accepted: 0,
      ignoredPruned: 0,
    });

    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });

  it("releases admission when persistence throws", async () => {
    externalUsageMocks.persist.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(POST(ordinaryRequest())).rejects.toThrow("database unavailable");

    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });

  it("accepts an exact signed receipt only for its dedicated token and provider ID", async () => {
    const response = await POST(receiptRequest());
    expect(response.status).toBe(202);
    expect(providerFindMany).toHaveBeenCalledWith({
      where: { id: { in: [RECEIPT_PROVIDER_ID] } },
      select: { id: true, name: true },
    });
    expect(externalUsageMocks.persist).toHaveBeenCalledWith([
      expect.objectContaining({
        provider: "anthropic",
        service: "api-prepaid-funding",
        label: "receipt_cash_paid",
        costUsd: 47.25,
        metadata: expect.not.objectContaining({
          receiptSignature: expect.anything(),
        }),
      }),
    ]);
  });

  it("uses only canonical server credentials for localhost URLs with non-loopback peers", async () => {
    vi.stubEnv("BILLING_RECEIPT_LOCAL_INGEST_TOKEN", LOCAL_RECEIPT_TOKEN);
    vi.stubEnv("BILLING_RECEIPT_LOCAL_HMAC_KEY", LOCAL_RECEIPT_HMAC_KEY);
    const localUrl = "http://localhost:4103/api/ingest/usage";
    const localOnlyResponse = await POST(
      receiptRequest({}, LOCAL_RECEIPT_TOKEN, localUrl, LOCAL_RECEIPT_HMAC_KEY)
    );
    expect(localOnlyResponse.status).toBe(401);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();

    const canonicalResponse = await POST(
      receiptRequest({}, RECEIPT_TOKEN, localUrl, RECEIPT_HMAC_KEY)
    );
    expect(canonicalResponse.status).toBe(202);
    expect(externalUsageMocks.persist).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary and receipt credentials mutually exclusive", async () => {
    expect((await POST(receiptRequest({}, USAGE_TOKEN))).status).toBe(401);
    expect((await POST(ordinaryRequest(RECEIPT_TOKEN))).status).toBe(401);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("fails closed when receipt credentials are shared or signature verification is absent", async () => {
    vi.stubEnv("BILLING_RECEIPT_INGEST_TOKEN", USAGE_TOKEN);
    expect((await POST(ordinaryRequest())).status).toBe(503);

    vi.stubEnv("BILLING_RECEIPT_INGEST_TOKEN", RECEIPT_TOKEN);
    vi.stubEnv("BILLING_RECEIPT_HMAC_KEY", "");
    expect((await POST(receiptRequest())).status).toBe(503);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("rejects malformed, tampered, future, or mismatched receipts", async () => {
    expect(
      (await POST(receiptRequest({ keyRef: "receipt-without-provider" }))).status
    ).toBe(400);
    expect(
      (
        await POST(
          receiptRequest({
            metadata: { receiptSignature: `hmac-sha256:${"0".repeat(64)}` },
          })
        )
      ).status
    ).toBe(400);
    expect(
      (await POST(receiptRequest({ occurredAt: "2099-01-01T00:00:00.000Z" }))).status
    ).toBe(400);

    providerFindMany.mockResolvedValueOnce([
      { id: RECEIPT_PROVIDER_ID, name: "openai" },
    ]);
    expect((await POST(receiptRequest())).status).toBe(400);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("validates every provider ID/name pair in a receipt batch", async () => {
    const response = await POST(
      nextRequest(
        {
          events: [
            receiptEvent(),
            receiptEvent({ provider: "openai", costUsd: 52.5 }),
          ],
        },
        RECEIPT_TOKEN
      )
    );
    expect(response.status).toBe(400);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });
});
