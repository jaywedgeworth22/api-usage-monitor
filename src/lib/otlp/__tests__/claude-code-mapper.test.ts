import { describe, it, expect } from "vitest";
import { mapClaudeCodeMetrics, PROVIDER, SERVICE, SOURCE_APP } from "../claude-code-mapper";
import type { OtlpExportMetricsServiceRequest } from "../types";

function sampleRequest(overrides: Partial<OtlpExportMetricsServiceRequest> = {}): OtlpExportMetricsServiceRequest {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "claude-code" } },
            { key: "service.version", value: { stringValue: "2.1.200" } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "com.anthropic.claude_code", version: "2.1.200" },
            metrics: [
              {
                name: "claude_code.token.usage",
                unit: "tokens",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: [
                        { key: "type", value: { stringValue: "input" } },
                        { key: "model", value: { stringValue: "claude-sonnet-5" } },
                        { key: "session.id", value: { stringValue: "abc-123" } },
                      ],
                      startTimeUnixNano: "1751500000000000000",
                      timeUnixNano: "1751500060000000000",
                      asInt: "1234",
                    },
                  ],
                },
              },
              {
                name: "claude_code.cost.usage",
                unit: "USD",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: [
                        { key: "model", value: { stringValue: "claude-sonnet-5" } },
                        { key: "session.id", value: { stringValue: "abc-123" } },
                      ],
                      startTimeUnixNano: "1751500000000000000",
                      timeUnixNano: "1751500060000000000",
                      asDouble: 0.0231,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("mapClaudeCodeMetrics", () => {
  it("maps claude_code.token.usage to a usage event with tokens as quantity", () => {
    const { events } = mapClaudeCodeMetrics(sampleRequest());
    const tokenEvent = events.find((e) => e.label?.startsWith("token:"));
    expect(tokenEvent).toBeDefined();
    expect(tokenEvent!.sourceApp).toBe(SOURCE_APP);
    expect(tokenEvent!.provider).toBe(PROVIDER);
    expect(tokenEvent!.service).toBe(SERVICE);
    expect(tokenEvent!.metricType).toBe("usage");
    expect(tokenEvent!.unit).toBe("token");
    expect(tokenEvent!.quantity).toBe(1234);
    expect(tokenEvent!.keyRef).toBe("claude-sonnet-5");
    expect(tokenEvent!.label).toBe("token:input");
    expect(tokenEvent!.metadata.tokenType).toBe("input");
  });

  it("maps claude_code.cost.usage to a cost event with costUsd set", () => {
    const { events } = mapClaudeCodeMetrics(sampleRequest());
    const costEvent = events.find((e) => e.metricType === "cost");
    expect(costEvent).toBeDefined();
    expect(costEvent!.costUsd).toBeCloseTo(0.0231);
    expect(costEvent!.keyRef).toBe("claude-sonnet-5");
  });

  it("maps all four token.usage type attributes distinctly", () => {
    const request: OtlpExportMetricsServiceRequest = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  sum: {
                    dataPoints: (["input", "output", "cacheRead", "cacheCreation"] as const).map((type, i) => ({
                      attributes: [
                        { key: "type", value: { stringValue: type } },
                        { key: "model", value: { stringValue: "claude-sonnet-5" } },
                      ],
                      timeUnixNano: `175150006000000000${i}`,
                      asInt: String(100 * (i + 1)),
                    })),
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const { events } = mapClaudeCodeMetrics(request);
    expect(events).toHaveLength(4);
    const byType = new Map(events.map((e) => [e.metadata.tokenType, e]));
    expect(byType.get("input")!.quantity).toBe(100);
    expect(byType.get("output")!.quantity).toBe(200);
    expect(byType.get("cacheRead")!.quantity).toBe(300);
    expect(byType.get("cacheCreation")!.quantity).toBe(400);
    // Each type must get a distinct idempotency key (different point attributes).
    const keys = new Set(events.map((e) => e.idempotencyKey));
    expect(keys.size).toBe(4);
  });

  it("maps claude_code.session.count into requests", () => {
    const request: OtlpExportMetricsServiceRequest = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.session.count",
                  sum: {
                    dataPoints: [
                      {
                        attributes: [{ key: "start_type", value: { stringValue: "fresh" } }],
                        timeUnixNano: "1751500060000000000",
                        asInt: "1",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const { events } = mapClaudeCodeMetrics(request);
    expect(events).toHaveLength(1);
    expect(events[0].requests).toBe(1);
    expect(events[0].unit).toBe("request");
    expect(events[0].label).toBe("session");
  });

  it("maps claude_code.lines_of_code.count with type attribute in metadata", () => {
    const request: OtlpExportMetricsServiceRequest = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.lines_of_code.count",
                  sum: {
                    dataPoints: [
                      {
                        attributes: [
                          { key: "type", value: { stringValue: "added" } },
                          { key: "model", value: { stringValue: "claude-sonnet-5" } },
                        ],
                        timeUnixNano: "1751500060000000000",
                        asInt: "42",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const { events } = mapClaudeCodeMetrics(request);
    expect(events).toHaveLength(1);
    expect(events[0].quantity).toBe(42);
    expect(events[0].unit).toBe("row");
    expect(events[0].metadata.locType).toBe("added");
  });

  it("tolerates unknown metric names: accepted (no throw), tallied, not mapped", () => {
    const request: OtlpExportMetricsServiceRequest = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.some_future_metric.count",
                  sum: {
                    dataPoints: [
                      { timeUnixNano: "1751500060000000000", asInt: "7" },
                      { timeUnixNano: "1751500060000000001", asInt: "8" },
                    ],
                  },
                },
                {
                  name: "claude_code.cost.usage",
                  sum: {
                    dataPoints: [{ timeUnixNano: "1751500060000000000", asDouble: 1.5 }],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => mapClaudeCodeMetrics(request)).not.toThrow();
    const { events, unknownMetrics } = mapClaudeCodeMetrics(request);
    // The known metric alongside the unknown one is still mapped.
    expect(events).toHaveLength(1);
    expect(events[0].metricType).toBe("cost");
    expect(unknownMetrics).toEqual([
      { name: "claude_code.some_future_metric.count", dataPointCount: 2 },
    ]);
  });

  it("returns no events and no unknown metrics for an empty request", () => {
    const { events, unknownMetrics } = mapClaudeCodeMetrics({});
    expect(events).toEqual([]);
    expect(unknownMetrics).toEqual([]);
  });

  it("skips data points with no numeric value instead of throwing", () => {
    const request: OtlpExportMetricsServiceRequest = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.cost.usage",
                  sum: { dataPoints: [{ timeUnixNano: "1751500060000000000" }] },
                },
              ],
            },
          ],
        },
      ],
    };
    const { events } = mapClaudeCodeMetrics(request);
    expect(events).toEqual([]);
  });

  it("produces the same idempotency key for a byte-identical retry", () => {
    const request = sampleRequest();
    const first = mapClaudeCodeMetrics(request);
    const second = mapClaudeCodeMetrics(structuredClone(request));
    expect(first.events.map((e) => e.idempotencyKey).sort()).toEqual(
      second.events.map((e) => e.idempotencyKey).sort()
    );
  });

  it("produces a different idempotency key when the value changes", () => {
    const requestA = sampleRequest();
    const requestB = sampleRequest();
    (requestB.resourceMetrics as any)[0].scopeMetrics[0].metrics[1].sum.dataPoints[0].asDouble = 9.99;
    const a = mapClaudeCodeMetrics(requestA).events.find((e) => e.metricType === "cost")!;
    const b = mapClaudeCodeMetrics(requestB).events.find((e) => e.metricType === "cost")!;
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it("extracts the project resource attribute (OTEL_RESOURCE_ATTRIBUTES) onto every event", () => {
    const request = sampleRequest();
    (request.resourceMetrics as any)[0].resource.attributes.push({
      key: "project",
      value: { stringValue: "socratic-trade" },
    });
    const { events } = mapClaudeCodeMetrics(request);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.projectName === "socratic-trade")).toBe(true);
  });

  it("accepts the dotted project.name attribute form", () => {
    const request = sampleRequest();
    (request.resourceMetrics as any)[0].resource.attributes.push({
      key: "project.name",
      value: { stringValue: "congress-trade" },
    });
    const { events } = mapClaudeCodeMetrics(request);
    expect(events.every((e) => e.projectName === "congress-trade")).toBe(true);
  });

  it("leaves projectName undefined when no project attribute is present", () => {
    const { events } = mapClaudeCodeMetrics(sampleRequest());
    expect(events.every((e) => e.projectName === undefined)).toBe(true);
  });
});
