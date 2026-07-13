import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardSummaryCards from "@/components/DashboardSummaryCards";

function renderSummary(incompleteCostProviderCount: number, totalCost = 0) {
  return renderToStaticMarkup(
    createElement(DashboardSummaryCards, {
      totalBalance: 25,
      totalProjectedMonthlyCost: 20,
      totalCost,
      incompleteCostProviderCount,
      attentionItemsCount: 0,
      criticalCount: 0,
      hasAnyCredits: false,
      totalCredits: 0,
    })
  );
}

describe("DashboardSummaryCards", () => {
  it("labels totals as known-only when provider cost coverage is incomplete", () => {
    const html = renderSummary(2, 12.5);

    expect(html).toContain("Known Spend This Month");
    expect(html).toContain("$12.50");
    expect(html).toContain("2 provider costs incomplete");
    expect(html).toContain("Known-Cost Projection");
    expect(html).toContain("Excludes unreported provider costs");
  });

  it("keeps explicit complete zero totals as zero", () => {
    const html = renderSummary(0);

    expect(html).toContain("Tracked Spend This Month");
    expect(html).toContain("Projected Monthly Spend");
    expect(html).toContain("$0.00");
    expect(html).not.toContain("provider cost incomplete");
  });
});
