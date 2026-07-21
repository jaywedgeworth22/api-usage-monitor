import { describe, expect, it } from "vitest";
import {
  buildProviderAlertState,
  resolveBudgetAlertTier,
} from "@/lib/provider-alerts";
import type { AnomalyResult } from "@/lib/anomaly-detection";

describe("resolveBudgetAlertTier hysteresis (C9)", () => {
  it("enters warning at 80% and exceeded at 100% from ok", () => {
    expect(resolveBudgetAlertTier(79, 100, "ok")).toBe("ok");
    expect(resolveBudgetAlertTier(80, 100, "ok")).toBe("warning");
    expect(resolveBudgetAlertTier(100, 100, "ok")).toBe("exceeded");
  });

  it("stays exceeded until spend clears below 95%", () => {
    expect(resolveBudgetAlertTier(96, 100, "exceeded")).toBe("exceeded");
    expect(resolveBudgetAlertTier(94, 100, "exceeded")).toBe("warning");
    expect(resolveBudgetAlertTier(74, 100, "exceeded")).toBe("ok");
  });

  it("stays in warning until spend clears below 75%", () => {
    expect(resolveBudgetAlertTier(76, 100, "warning")).toBe("warning");
    expect(resolveBudgetAlertTier(74, 100, "warning")).toBe("ok");
    expect(resolveBudgetAlertTier(100, 100, "warning")).toBe("exceeded");
  });
});


describe("buildProviderAlertState snapshot capability", () => {
  it("keeps budget alerts but suppresses impossible snapshot alerts for push/manual tracking", () => {
    const state = buildProviderAlertState(
      {
        isActive: true,
        refreshIntervalMin: 60,
        snapshotExpected: false,
        plan: {
          billingMode: "actual",
          fixedMonthlyCostUsd: null,
          monthlyBudgetUsd: 10,
          monthlyRequestLimit: null,
          lowBalanceUsd: null,
          lowCredits: null,
          renewalDate: null,
          mustKeepFunded: false,
        },
        latestSnapshot: null,
        trackedSpendUsd: 12,
      },
      new Date("2026-07-14T12:00:00.000Z")
    );

    expect(state.alerts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "budget_exceeded" })])
    );
    expect(state.alerts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_snapshot" }),
      ])
    );
    expect(state.alerts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "stale_snapshot" }),
      ])
    );
  });
});

describe("buildProviderAlertState anomaly emission", () => {
  const costAnomaly: AnomalyResult = {
    providerId: "prov-1",
    metric: "cost",
    day: "2026-07-19",
    observed: 100,
    baselineCenter: 10,
    baselineSpread: 1.48,
    expectedLow: 4.82,
    expectedHigh: 15.18,
    sigmas: 60,
    severity: "critical",
    method: "mad",
    windowSize: 10,
  };

  it("emits a spend_anomaly alert from a pre-computed cost anomaly", () => {
    const state = buildProviderAlertState(
      {
        isActive: true,
        refreshIntervalMin: 60,
        plan: null,
        latestSnapshot: null,
        snapshotExpected: false,
        anomalies: [costAnomaly],
      },
      new Date("2026-07-19T12:00:00.000Z")
    );

    expect(state.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "spend_anomaly", severity: "critical" }),
      ])
    );
    const alert = state.alerts.find((a) => a.code === "spend_anomaly");
    expect(alert?.message).toContain("Spend spike");
  });

  it("maps the requests metric to a request_anomaly code", () => {
    const state = buildProviderAlertState(
      {
        isActive: true,
        refreshIntervalMin: 60,
        plan: null,
        latestSnapshot: null,
        snapshotExpected: false,
        anomalies: [{ ...costAnomaly, metric: "requests", severity: "warning" }],
      },
      new Date("2026-07-19T12:00:00.000Z")
    );
    expect(state.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "request_anomaly", severity: "warning" }),
      ])
    );
  });

  it("emits no anomaly alert when none are supplied", () => {
    const state = buildProviderAlertState(
      {
        isActive: true,
        refreshIntervalMin: 60,
        plan: null,
        latestSnapshot: null,
        snapshotExpected: false,
      },
      new Date("2026-07-19T12:00:00.000Z")
    );
    expect(state.alerts.some((a) => a.code === "spend_anomaly" || a.code === "request_anomaly")).toBe(false);
  });
});
