import { describe, it, expect } from "vitest";
import { mapSystemMetrics, SOURCE_APP, PROVIDER, SERVICE } from "../system-mapper";
import type { OtlpExportMetricsServiceRequest } from "../types";

describe("system-mapper", () => {
  it("maps known system metrics", () => {
    const request: OtlpExportMetricsServiceRequest = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "host.name", value: { stringValue: "web-01" } },
              { key: "deployment.environment", value: { stringValue: "production" } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "system.cpu.utilization",
                  gauge: {
                    dataPoints: [
                      {
                        asDouble: 0.85,
                        attributes: [{ key: "state", value: { stringValue: "user" } }],
                        timeUnixNano: "1720560000000000000",
                      },
                    ],
                  },
                },
                {
                  name: "system.memory.usage",
                  sum: {
                    dataPoints: [
                      {
                        asInt: "4096000",
                        attributes: [{ key: "state", value: { stringValue: "used" } }],
                        timeUnixNano: "1720560000000000000",
                      },
                    ],
                  },
                },
                {
                  name: "unknown.metric",
                  sum: {
                    dataPoints: [{ asInt: "1" }],
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const { events, unknownMetrics } = mapSystemMetrics(request);

    expect(unknownMetrics).toEqual([{ name: "unknown.metric", dataPointCount: 1 }]);
    expect(events).toHaveLength(2);

    const cpu = events.find((e) => e.label === "cpu:user")!;
    expect(cpu).toBeDefined();
    expect(cpu.sourceApp).toBe(SOURCE_APP);
    expect(cpu.provider).toBe(PROVIDER);
    expect(cpu.service).toBe(SERVICE);
    expect(cpu.environment).toBe("production");
    expect(cpu.keyRef).toBe("web-01");
    expect(cpu.metricType).toBe("health");
    expect(cpu.quantity).toBe(0.85);

    const mem = events.find((e) => e.label === "memory:used")!;
    expect(mem).toBeDefined();
    expect(mem.quantity).toBe(4096000);
    expect(mem.unit).toBe("byte");
  });
});
