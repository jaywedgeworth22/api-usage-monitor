import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ProviderTable from "@/components/ProviderTable";
import type { Provider } from "@/app/settings/page";

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: "provider-1",
    name: "openai",
    displayName: "OpenAI",
    type: "builtin",
    isActive: true,
    refreshIntervalMin: 60,
    groupId: null,
    label: null,
    plan: null,
    allocations: [],
    alerts: [],
    estimatedMonthlyCostUsd: 0,
    spentUsd: 0,
    projectedEomUsd: 0,
    spendCoverage: "complete",
    pushedCostCoverage: "complete",
    pushedPricedEventCount: 1,
    pushedUnpricedEventCount: 0,
    pushedUnclassifiedCostEventCount: 0,
    billingMode: "actual",
    createdAt: "2026-07-13T00:00:00.000Z",
    latestSnapshot: null,
    ...overrides,
  };
}

function renderTable(providers: Provider[]) {
  const noop = vi.fn();
  return renderToStaticMarkup(
    createElement(ProviderTable, {
      providers,
      actionLoading: null,
      deleteConfirm: null,
      onEdit: noop,
      onDeleteConfirmStart: noop,
      onDeleteConfirmCancel: noop,
      onDelete: noop,
      onAddProvider: noop,
      onToggleActive: noop,
      onFetchNow: noop,
    })
  );
}

describe("ProviderTable cost coverage", () => {
  it("distinguishes partial known spend from unknown cost", () => {
    const html = renderTable([
      provider({
        id: "partial",
        spentUsd: 12.5,
        projectedEomUsd: 20,
        spendCoverage: "partial",
        pushedUnpricedEventCount: 2,
      }),
      provider({
        id: "unknown",
        displayName: "Gemini",
        name: "google-ai",
        spendCoverage: "unknown",
        pushedCostCoverage: "unknown",
        pushedPricedEventCount: 0,
        pushedUnpricedEventCount: 1,
      }),
    ]);

    expect(html).toContain("Known group spend");
    expect(html).toContain("2 incomplete");
    expect(html).toContain("$12.50 known MTD");
    expect(html).toContain("2 unpriced events");
    expect(html).toContain("Cost not reported");
    expect(html).toContain("Projection unavailable");
  });

  it("keeps a complete explicit zero as zero", () => {
    const html = renderTable([provider({ spentUsd: 0, spendCoverage: "complete" })]);

    expect(html).toContain("$0.00 MTD");
    expect(html).not.toContain("Cost not reported");
  });
});
