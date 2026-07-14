import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../sentry";

const ORG_SLUG = "jays-services";
const PROJECTS_PATH = `/api/0/organizations/${ORG_SLUG}/projects/`;

function jsonResponse(
  body: unknown,
  options: { status?: number; link?: string } = {}
): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.link) headers.set("link", options.link);
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers,
  });
}

function projectPage(
  projects: unknown[],
  nextCursor: string | null = null
): Response {
  const previousUrl = `https://sentry.io${PROJECTS_PATH}?per_page=100&cursor=previous`;
  const nextUrl = `https://sentry.io${PROJECTS_PATH}?per_page=100&cursor=${encodeURIComponent(nextCursor ?? "end")}`;
  return jsonResponse(projects, {
    link: [
      `<${previousUrl}>; rel="previous"; results="false"`,
      `<${nextUrl}>; rel="next"; results="${nextCursor == null ? "false" : "true"}"`,
    ].join(", "),
  });
}

function statsResponse(groups: unknown[]): Response {
  return jsonResponse({ groups });
}

describe("sentry adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("discovers projects and reports exact UTC MTD per-project stats without mixing units", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T15:16:17.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(projectPage([{ id: "101" }, { id: 202 }]))
      .mockResolvedValueOnce(
        statsResponse([
          {
            by: { category: "error", outcome: "accepted" },
            totals: { "sum(quantity)": 12 },
          },
          {
            by: { category: "attachment", outcome: "accepted" },
            totals: { "sum(quantity)": "2048" },
          },
        ])
      )
      .mockResolvedValueOnce(
        statsResponse([
          {
            by: { category: "profile_duration", outcome: "accepted" },
            totals: { "sum(quantity)": 3500 },
          },
        ])
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { orgSlug: ORG_SLUG });

    expect(result.totalCost).toBeNull();
    expect(result.costScope).toBe("unknown");
    expect(result.totalRequests).toBe(12);
    expect(result.rawData).toMatchObject({
      groupedBy: ["category", "outcome", "project"],
      queryStrategy: "per_project",
      projectDiscovery: { accessibleProjects: 2, pages: 1 },
      totals: { events: 12, bytes: 2048, milliseconds: 3500 },
      capabilities: {
        usageByCategoryOutcomeProject: true,
        billingCost: false,
      },
    });
    expect(result.externalBilling).toMatchObject({
      source: "sentry-stats-v2",
      authoritative: true,
      records: [
        {
          serviceName: "Project 101: error (accepted)",
          usageQuantity: 12,
          usageUnit: "events",
        },
        {
          serviceName: "Project 101: attachment (accepted)",
          usageQuantity: 2048,
          usageUnit: "bytes",
        },
        {
          serviceName: "Project 202: profile_duration (accepted)",
          usageQuantity: 3500,
          usageUnit: "milliseconds",
        },
      ],
    });
    for (const record of result.externalBilling?.records ?? []) {
      expect(record.amountUsd).toBeUndefined();
      expect(record.requestLimit).toBeUndefined();
      expect(record.planName).toBeUndefined();
      expect(record.nextRenewalAt).toBeUndefined();
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const discoveryUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(discoveryUrl.pathname).toBe(PROJECTS_PATH);
    expect(discoveryUrl.searchParams.get("per_page")).toBe("100");
    expect(discoveryUrl.searchParams.has("cursor")).toBe(false);

    const statsUrls = fetchMock.mock.calls.slice(1).map((call) => new URL(String(call[0])));
    expect(statsUrls.map((url) => url.searchParams.get("project"))).toEqual([
      "101",
      "202",
    ]);
    for (const url of statsUrls) {
      expect(url.pathname).toBe(`/api/0/organizations/${ORG_SLUG}/stats_v2/`);
      expect(url.searchParams.get("field")).toBe("sum(quantity)");
      expect(url.searchParams.getAll("groupBy")).toEqual([
        "category",
        "outcome",
      ]);
      expect(url.searchParams.get("start")).toBe("2026-07-01T00:00:00.000Z");
      expect(url.searchParams.get("end")).toBe("2026-07-13T15:16:17.000Z");
    }
  });

  it("follows every project discovery page before querying project usage", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(projectPage([{ id: "101" }], "cursor:one"))
      .mockResolvedValueOnce(projectPage([{ id: "202" }]))
      .mockResolvedValueOnce(statsResponse([]))
      .mockResolvedValueOnce(statsResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { orgSlug: ORG_SLUG });

    expect(result.rawData).toMatchObject({
      projectDiscovery: { accessibleProjects: 2, pages: 2 },
    });
    expect(result.externalBilling).toMatchObject({
      authoritative: true,
      records: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const secondPageUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(secondPageUrl.pathname).toBe(PROJECTS_PATH);
    expect(secondPageUrl.searchParams.get("cursor")).toBe("cursor:one");
    expect(
      fetchMock.mock.calls.slice(2).map((call) =>
        new URL(String(call[0])).searchParams.get("project")
      )
    ).toEqual(["101", "202"]);
  });

  it("fails the whole sync when any project stats query fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(projectPage([{ id: "101" }, { id: "202" }]))
      .mockResolvedValueOnce(statsResponse([]))
      .mockResolvedValueOnce(jsonResponse({ detail: "forbidden" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchUsage("token", { orgSlug: ORG_SLUG })
    ).rejects.toMatchObject({ code: "HTTP_ERROR", status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed project discovery payloads before authoritative reconciliation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ projects: [{ id: "101" }] }, {
          link: `<https://sentry.io${PROJECTS_PATH}?cursor=end>; rel="next"; results="false"`,
        })
      )
    );

    await expect(
      fetchUsage("token", { orgSlug: ORG_SLUG })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects malformed per-project stats payloads before authoritative reconciliation", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(projectPage([{ id: "101" }]))
        .mockResolvedValueOnce(jsonResponse({ groups: "not-an-array" }))
    );

    await expect(
      fetchUsage("token", { orgSlug: ORG_SLUG })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects missing project pagination metadata instead of assuming the first page is complete", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([{ id: "101" }])));

    await expect(
      fetchUsage("token", { orgSlug: ORG_SLUG })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects quantities that cannot be stored without changing their unit or precision", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(projectPage([{ id: "101" }]))
        .mockResolvedValueOnce(
          statsResponse([
            {
              by: { category: "error", outcome: "accepted" },
              totals: { "sum(quantity)": 1.5 },
            },
          ])
        )
    );

    await expect(
      fetchUsage("token", { orgSlug: ORG_SLUG })
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
