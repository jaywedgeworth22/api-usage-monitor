import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../google-ai";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const privateKey = generateKeyPairSync("rsa", { modulusLength: 1024 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

function serviceAccountJson(): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "billing-query-project",
    private_key_id: "test-key-id",
    private_key: privateKey,
    client_email: "usage-monitor@billing-query-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

const fields = [
  "project_id",
  "project_number",
  "project_name",
  "sku_id",
  "sku_description",
  "usage_unit",
  "report_through",
  "invalid_rate_rows",
  "net_usd",
  "usage_quantity",
];

function billingRow(projectId: string, netUsd: string, skuId = "sku-1") {
  return {
    f: [
      { v: projectId },
      { v: "123456" },
      { v: "Gemini project" },
      { v: skuId },
      { v: "Gemini 2.5 input" },
      { v: "characters" },
      { v: "2026-07-13 20:00:00+00" },
      { v: "0" },
      { v: netUsd },
      { v: "1200" },
    ],
  };
}

function mockGoogle(options: {
  modelStatus?: number;
  rows?: ReturnType<typeof billingRow>[];
  queryStatus?: number;
  queryCompletesAsync?: boolean;
  tablePending?: boolean;
} = {}) {
  const queryRows = options.rows ?? [billingRow("gemini-prod", "8.25")];
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      return Promise.resolve(
        jsonResponse(
          options.modelStatus && options.modelStatus !== 200
            ? { error: "invalid key" }
            : { models: [{ name: "gemini" }] },
          options.modelStatus ?? 200,
          { "x-ratelimit-remaining": "90", "x-ratelimit-limit": "100" }
        )
      );
    }
    if (url === "https://oauth2.googleapis.com/token") {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).not.toContain("PRIVATE KEY");
      return Promise.resolve(jsonResponse({ access_token: "oauth-token" }));
    }
    if (url.includes("/datasets/billing_export/tables")) {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer oauth-token" });
      if (options.tablePending) {
        return Promise.resolve(jsonResponse({ tables: [] }));
      }
      return Promise.resolve(
        jsonResponse({
          tables: [
            { tableReference: { tableId: "gcp_billing_export_v1_ABCDEF_123456" } },
            { tableReference: { tableId: "gcp_billing_export_resource_v1_ABCDEF_123456" } },
          ],
        })
      );
    }
    if (url.endsWith("/projects/billing-query-project/queries")) {
      const body = JSON.parse(String(init?.body));
      expect(body.maximumBytesBilled).toBe("1073741824");
      expect(body.query).toContain("service.description = 'Gemini API'");
      expect(body.query).toContain("cost_type = 'regular'");
      expect(body.query).toContain("_PARTITIONTIME >= @window_start");
      expect(body.query).toContain("_PARTITIONTIME < @window_end");
      expect(body.query).toContain("ANY_VALUE(project.name)");
      expect(body.query).toContain("GROUP BY project.id, sku.id, usage.pricing_unit");
      expect(body.query).toContain("UNNEST(credits)");
      if (options.queryStatus && options.queryStatus !== 200) {
        return Promise.resolve(jsonResponse({ error: "forbidden" }, options.queryStatus));
      }
      if (options.queryCompletesAsync) {
        return Promise.resolve(
          jsonResponse({
            jobComplete: false,
            jobReference: {
              projectId: "billing-query-project",
              jobId: "job-1",
              location: "US",
            },
          })
        );
      }
      return Promise.resolve(
        jsonResponse({
          jobComplete: true,
          jobReference: {
            projectId: "billing-query-project",
            jobId: "job-1",
            location: "US",
          },
          schema: { fields: fields.map((name) => ({ name })) },
          rows: queryRows,
          totalRows: String(queryRows.length),
        })
      );
    }
    if (url.includes("/projects/billing-query-project/queries/job-1")) {
      expect(url).toContain("location=US");
      return Promise.resolve(
        jsonResponse({
          jobComplete: true,
          jobReference: {
            projectId: "billing-query-project",
            jobId: "job-1",
            location: "US",
          },
          schema: { fields: fields.map((name) => ({ name })) },
          rows: queryRows,
          totalRows: String(queryRows.length),
        })
      );
    }
    return Promise.reject(new Error(`Unexpected Google URL: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("google-ai billing adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T20:30:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps key-only validation non-billable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ models: [{ name: "gemini" }] }, 200, {
        "x-ratelimit-remaining": "90",
        "x-ratelimit-limit": "100",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("gemini-key");

    expect(result.totalCost).toBeNull();
    expect(result.rawData).toMatchObject({
      keyValidation: { ok: true, availableModelCount: 1 },
      billing: { configured: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("auto-discovers the standard export and returns exact calendar-month cost", async () => {
    const fetchMock = mockGoogle();

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBe(8.25);
    expect(result.costScope).toBe("calendar_month_to_date");
    expect(new Date(result.costWindowStart!).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serviceName: "Gemini API",
          amountUsd: 8.25,
          currency: "USD",
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          planName: "Gemini 2.5 input",
          usageQuantity: 1200,
          rollupRole: "component",
        }),
      ])
    );
    expect(result.rawData).toMatchObject({
      billing: {
        configured: true,
        status: "ready",
        tableId: "gcp_billing_export_v1_ABCDEF_123456",
        observedProjectCount: 1,
        maximumBytesBilled: 1_073_741_824,
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("resource_v1"))).toBe(false);
  });

  it("keeps authoritative billing when model-list key validation fails", async () => {
    mockGoogle({ modelStatus: 401 });

    const result = await fetchUsage("stale-gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBe(8.25);
    expect(result.rawData).toMatchObject({ keyValidation: { ok: false, status: 401 } });
  });

  it("uses the result schema returned after an asynchronous query completes", async () => {
    const fetchMock = mockGoogle({ queryCompletesAsync: true });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBe(8.25);
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).includes("/queries/job-1")
      )
    ).toBe(true);
  });

  it("keeps an empty billing export pending instead of inventing zero spend", async () => {
    mockGoogle({ rows: [] });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBeNull();
    expect(result.costWindowEnd).toBeNull();
    expect(result.externalBilling?.records).toEqual([
      expect.objectContaining({
        amountUsd: null,
        status: "pending",
        currentPeriodEnd: null,
        rollupRole: "canonical",
      }),
    ]);
    expect(result.externalBilling?.authoritative).toBe(false);
    expect(result.rawData).toMatchObject({
      billing: { configured: true, status: "pending" },
      capabilities: { billingCost: false },
    });
  });

  it("treats an enabled export whose first table is still provisioning as pending", async () => {
    const fetchMock = mockGoogle({ tablePending: true });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBeNull();
    expect(result.costWindowEnd).toBeNull();
    expect(result.rawData).toMatchObject({
      billing: {
        configured: true,
        status: "pending",
        tableId: null,
        observedProjectCount: 0,
      },
      capabilities: { billingCost: false },
    });
    expect(result.externalBilling).toMatchObject({
      authoritative: false,
      records: [
        expect.objectContaining({
          status: "pending",
          amountUsd: null,
          currentPeriodEnd: null,
        }),
      ],
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith("/projects/billing-query-project/queries")
      )
    ).toBe(false);
  });

  it("preserves explicit zero when a priced export row nets to zero", async () => {
    mockGoogle({ rows: [billingRow("gemini-prod", "0")] });

    const result = await fetchUsage("gemini-key", {
      billingDataset: "billing-data-project.billing_export",
      serviceAccountJson: serviceAccountJson(),
    });

    expect(result.totalCost).toBe(0);
    expect(result.costWindowEnd).toBe("2026-07-13T20:30:00.000Z");
    expect(result.externalBilling?.records[0]).toMatchObject({
      amountUsd: 0,
      status: "active",
      rollupRole: "canonical",
    });
  });

  it("fails closed when unscoped billing spans multiple projects", async () => {
    mockGoogle({
      rows: [billingRow("gemini-prod", "8.25"), billingRow("gemini-lab", "2.50", "sku-2")],
    });

    await expect(
      fetchUsage("gemini-key", {
        billingDataset: "billing-data-project.billing_export",
        serviceAccountJson: serviceAccountJson(),
      })
    ).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });

  it("never converts a billing-query failure into zero cost", async () => {
    mockGoogle({ queryStatus: 403 });

    await expect(
      fetchUsage("gemini-key", {
        billingDataset: "billing-data-project.billing_export",
        serviceAccountJson: serviceAccountJson(),
      })
    ).rejects.toMatchObject({ code: "HTTP_ERROR", status: 403 });
  });

  it("rejects credential configurations with a non-Google token endpoint", async () => {
    const credential = JSON.parse(serviceAccountJson());
    credential.token_uri = "https://example.com/steal";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ models: [{ name: "gemini" }] }))
    );

    await expect(
      fetchUsage("gemini-key", {
        billingDataset: "billing-data-project.billing_export",
        serviceAccountJson: JSON.stringify(credential),
      })
    ).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });
});
