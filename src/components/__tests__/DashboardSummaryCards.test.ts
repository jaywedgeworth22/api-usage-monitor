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

  it("renders a single bordered KPI strip instead of separate cards", () => {
    const html = renderSummary(0);

    expect(html.match(/gap-px/g)?.length).toBe(1);
    expect(html).not.toContain("p-6");
  });

  it("links the Open Alerts cell to the attention anchor", () => {
    const html = renderSummary(0);

    expect(html).toContain('href="#attention"');
  });

  it("renders the Total Credits cell only when hasAnyCredits is true", () => {
    const withoutCredits = renderToStaticMarkup(
      createElement(DashboardSummaryCards, {
        totalBalance: 25,
        totalProjectedMonthlyCost: 20,
        totalCost: 0,
        incompleteCostProviderCount: 0,
        attentionItemsCount: 0,
        criticalCount: 0,
        hasAnyCredits: false,
        totalCredits: 0,
      })
    );
    const withCredits = renderToStaticMarkup(
      createElement(DashboardSummaryCards, {
        totalBalance: 25,
        totalProjectedMonthlyCost: 20,
        totalCost: 0,
        incompleteCostProviderCount: 0,
        attentionItemsCount: 0,
        criticalCount: 0,
        hasAnyCredits: true,
        totalCredits: 42,
      })
    );

    expect(withoutCredits).not.toContain("Total Credits");
    expect(withCredits).toContain("Total Credits");
  });
});
