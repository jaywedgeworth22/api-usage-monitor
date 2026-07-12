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
});
