import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProjectsPanel, { type ProjectBudgetStatus } from "@/components/ProjectsPanel";

function project(
  overrides: Partial<ProjectBudgetStatus>
): ProjectBudgetStatus {
  return {
    id: "project-1",
    name: "Congress.Trade",
    description: null,
    monthlyBudgetUsd: 100,
    spentUsd: 0,
    projectedEomUsd: 0,
    spendCoverage: "complete",
    pricedEventCount: 1,
    unpricedEventCount: 0,
    unclassifiedCostEventCount: 0,
    incompleteAllocatedProviderCount: 0,
    directUsd: 0,
    allocatedUsd: 0,
    remainingUsd: 100,
    percentUsed: 0,
    status: "ok",
    ...overrides,
  };
}

describe("ProjectsPanel cost coverage", () => {
  it("keeps a complete explicit zero as zero", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectsPanel, { projects: [project({})] })
    );

    expect(html).toContain("$0.00");
    expect(html).not.toContain("Cost not reported");
  });

  it("does not present unpriced project usage as zero spend", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectsPanel, {
        projects: [
          project({
            spendCoverage: "unknown",
            pricedEventCount: 0,
            unpricedEventCount: 12,
            percentUsed: 0,
          }),
        ],
      })
    );

    expect(html).toContain("Cost not reported");
    expect(html).toContain("12 unpriced events");
    expect(html).not.toContain('role="progressbar"');
  });

  it("labels a partial project subtotal and incomplete allocations", () => {
    const html = renderToStaticMarkup(
      createElement(ProjectsPanel, {
        projects: [
          project({
            spentUsd: 8,
            spendCoverage: "partial",
            unpricedEventCount: 2,
            incompleteAllocatedProviderCount: 1,
            percentUsed: 0.08,
          }),
        ],
      })
    );

    expect(html).toContain("$8.00 known");
    expect(html).toContain("2 unpriced events");
    expect(html).toContain("1 allocated provider cost incomplete");
    expect(html).toContain("Congress.Trade known monthly budget used");
  });
});
