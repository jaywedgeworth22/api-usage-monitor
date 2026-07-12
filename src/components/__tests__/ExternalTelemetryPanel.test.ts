import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ExternalTelemetryPanel from "@/components/ExternalTelemetryPanel";

describe("ExternalTelemetryPanel", () => {
  it("renders authoritative zero values and zero-percent quota instead of treating them as missing", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalTelemetryPanel, {
        usageSummary: {
          days: 30,
          totalCostUsd: 0,
          totalRequests: 0,
          eventCount: 1,
          groups: [
            {
              sourceApp: "demo",
              environment: null,
              provider: "resend",
              service: "email",
              projectId: null,
              metricType: "usage",
              unit: "requests",
              eventCount: 1,
              totalCostUsd: 0,
              totalRequests: 0,
              totalQuantity: 0,
              limit: 100,
              limitWindow: "day",
              latestAt: "2026-07-12T00:00:00.000Z",
            },
          ],
        },
      })
    );

    expect(html).toContain("$0.00");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("0.0% of");
  });

  it("uses request count consistently for the displayed usage and quota percent", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalTelemetryPanel, {
        usageSummary: {
          days: 30,
          totalCostUsd: 0,
          totalRequests: 500,
          eventCount: 1,
          groups: [
            {
              sourceApp: "demo",
              environment: null,
              provider: "resend",
              service: "email",
              projectId: null,
              metricType: "usage",
              unit: "requests",
              eventCount: 1,
              totalCostUsd: 0,
              totalRequests: 500,
              totalQuantity: 0,
              limit: 1000,
              limitWindow: "day",
              latestAt: "2026-07-12T00:00:00.000Z",
            },
          ],
        },
      })
    );

    expect(html).toContain("500");
    expect(html).toContain("50.0% of");
  });

  it("uses quantity for a unit-specific quota even when request metadata is also present", () => {
    const html = renderToStaticMarkup(
      createElement(ExternalTelemetryPanel, {
        usageSummary: {
          days: 30,
          totalCostUsd: 0,
          totalRequests: 10,
          eventCount: 1,
          groups: [
            {
              sourceApp: "demo",
              environment: null,
              provider: "openai",
              service: "responses",
              projectId: null,
              metricType: "usage",
              unit: "tokens",
              eventCount: 1,
              totalCostUsd: 0,
              totalRequests: 10,
              totalQuantity: 10_000,
              limit: 20_000,
              limitWindow: "month",
              latestAt: "2026-07-12T00:00:00.000Z",
            },
          ],
        },
      })
    );

    expect(html).toContain("10,000");
    expect(html).toContain("50.0% of");
    expect(html).toContain("responses · tokens");
  });
});
