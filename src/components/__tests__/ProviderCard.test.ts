import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ProviderCard from "@/components/ProviderCard";

describe("ProviderCard", () => {
  it("shows provider-reported cost as positive spend rather than a negative balance", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "github",
        name: "github",
        displayName: "GitHub",
        type: "builtin",
        isActive: true,
        latestSnapshot: {
          balance: null,
          totalCost: 18.4,
          totalRequests: null,
          credits: null,
          fetchedAt: "2026-07-12T00:00:00.000Z",
        },
      })
    );

    expect(html).toContain("$18.40");
    expect(html).not.toContain("-$18.40");
  });

  it("renders an explicit zero when cost coverage is complete", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "gemini",
        name: "google-ai",
        displayName: "Gemini",
        type: "builtin",
        isActive: true,
        spentUsd: 0,
        projectedEomUsd: 0,
        spendCoverage: "complete",
        latestSnapshot: null,
      })
    );

    expect(html).toContain("Tracked MTD / projected EOM");
    expect(html).toContain("$0.00");
    expect(html).not.toContain("Cost not reported");
  });

  it("does not turn usage without cost into authoritative zero spend", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "gemini",
        name: "google-ai",
        displayName: "Gemini",
        type: "builtin",
        isActive: true,
        spentUsd: 0,
        projectedEomUsd: 0,
        spendCoverage: "unknown",
        pushedUnpricedEventCount: 2,
        latestSnapshot: null,
      })
    );

    expect(html).toContain("Cost not reported");
    expect(html).toContain("Projection unavailable");
    expect(html).toContain("2 usage events without cost");
    expect(html).not.toContain("$0.00");
  });

  it("labels partial spend as a known subtotal with unpriced event count", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCard, {
        id: "openai",
        name: "openai",
        displayName: "OpenAI",
        type: "builtin",
        isActive: true,
        spentUsd: 12.5,
        projectedEomUsd: 20,
        spendCoverage: "partial",
        pushedUnpricedEventCount: 2,
        pushedUnclassifiedCostEventCount: 1,
        latestSnapshot: null,
      })
    );

    expect(html).toContain("Known MTD / known-cost projection");
    expect(html).toContain("$12.50");
    expect(html).toContain("from known costs");
    expect(html).toContain("3 unpriced events");
  });
});
