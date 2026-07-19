import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { markOperationsStale, ReceiptInboxCard, SocraticInfrastructureCard } from "@/components/OperationsOverview";

describe("OperationsOverview cards", () => {
  it("keeps receipt evidence separate from money and labels unconfigured state", () => {
    const html = renderToStaticMarkup(createElement(ReceiptInboxCard, {
      data: {
        configured: false,
        state: "unconfigured",
        needsReviewCount: 0,
        countIsLowerBound: false,
        latestReceivedAt: null,
        fetchedAt: "2026-07-18T10:00:00.000Z",
        items: [],
      },
    }));
    expect(html).toContain("Receipt inbox");
    expect(html).toContain("Not configured");
    expect(html).toContain("review is required before any cost is recorded");
    expect(html).not.toContain("$0");
  });

  it("shows unavailable infrastructure values without fabricating zero metrics", () => {
    const html = renderToStaticMarkup(createElement(SocraticInfrastructureCard, {
      data: {
        state: "unreachable",
        fetchedAt: "2026-07-18T10:00:00.000Z",
        releaseSha: null,
        database: "unknown",
        schedulerAgeSeconds: null,
        activeTradingAccounts: null,
        degradedTradingAccounts: null,
        failedDependencies: [],
        dbSizeBytes: null,
        walSizeBytes: null,
        freeBytes: null,
        totalBytes: null,
        litestreamState: null,
        litestreamAgeSeconds: null,
        adminUrl: "https://admin.socratictrade.com/admin/server",
      },
    }));
    expect(html).toContain("Socratic Trade infrastructure");
    expect(html).toContain("Unreachable");
    expect(html).toContain("scheduler unavailable");
    expect(html).not.toContain("0 GB");
    expect(html).not.toContain("0%");
  });

  it("marks both previously healthy cards stale when the dashboard refresh fails", () => {
    const stale = markOperationsStale({
      fetchedAt: "2026-07-18T10:00:00.000Z",
      receiptInbox: {
        configured: true,
        state: "receiving",
        needsReviewCount: 1,
        countIsLowerBound: false,
        latestReceivedAt: "2026-07-18T09:00:00.000Z",
        fetchedAt: "2026-07-18T10:00:00.000Z",
        items: [],
      },
      socraticInfrastructure: {
        state: "healthy",
        fetchedAt: "2026-07-18T10:00:00.000Z",
        releaseSha: null,
        database: "ok",
        schedulerAgeSeconds: 10,
        activeTradingAccounts: 1,
        degradedTradingAccounts: 0,
        failedDependencies: [],
        dbSizeBytes: null,
        walSizeBytes: null,
        freeBytes: null,
        totalBytes: null,
        litestreamState: "replicating",
        litestreamAgeSeconds: 10,
        adminUrl: "https://admin.socratictrade.com/admin/server",
      },
    });
    expect(stale.receiptInbox.state).toBe("stale");
    expect(stale.socraticInfrastructure.state).toBe("stale");
    expect(stale.receiptInbox.error).toBe("dashboard_refresh_failed");
  });
});
