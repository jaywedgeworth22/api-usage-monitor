import { describe, expect, it } from "vitest";
import {
  dailyIncrementsFromSnapshotPeaks,
  maxDailySeries,
} from "../daily-usage-series";
import { calculateEomForecast, calculateEomForecastFromSeries } from "../forecasting";

describe("daily-usage-series helpers (Wave J / E11)", () => {
  it("builds incremental series from cumulative snapshot peaks", () => {
    const monthStart = new Date("2026-07-01T00:00:00.000Z");
    const now = new Date("2026-07-04T12:00:00.000Z");
    const peaks = new Map([
      ["2026-07-01", 10],
      ["2026-07-02", 25],
      ["2026-07-04", 40],
    ]);
    const series = dailyIncrementsFromSnapshotPeaks(peaks, monthStart, now);
    expect(series).toEqual([10, 15, 0, 15]);
  });

  it("takes element-wise max of two series", () => {
    expect(maxDailySeries([1, 5, 0], [2, 3, 9])).toEqual([2, 5, 9]);
    expect(maxDailySeries(null, [1, 2])).toEqual([1, 2]);
    expect(maxDailySeries([1], null)).toEqual([1]);
    expect(maxDailySeries(null, null)).toBeNull();
  });
});

describe("calculateEomForecastFromSeries fallback (Wave J / E11)", () => {
  it("linear-extrapolates usageSoFarFallback when series is empty", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const withFallback = calculateEomForecastFromSeries([], 10, now, {
      usageSoFarFallback: 50,
    });
    const linear = calculateEomForecast(60, 10, now);
    expect(withFallback).toBeCloseTo(linear, 8);
  });

  it("uses series projection when daily samples exist", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    // Rising daily usage: series forecast should exceed pure average-rate
    // linear on early days of a steep ramp.
    const daily = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20];
    const seriesTotal = calculateEomForecastFromSeries(daily, 0, now);
    const linearTotal = calculateEomForecast(
      daily.reduce((a, b) => a + b, 0),
      0,
      now
    );
    expect(seriesTotal).toBeGreaterThan(linearTotal);
  });
});
