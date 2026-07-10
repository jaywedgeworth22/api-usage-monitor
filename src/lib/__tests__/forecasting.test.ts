import { describe, it, expect } from "vitest";
import { calculateEomForecast } from "../forecasting";

describe("calculateEomForecast", () => {
  it("extrapolates spend based on the day of the month", () => {
    // January 15, noon UTC
    const now = new Date(Date.UTC(2025, 0, 15, 12, 0, 0));
    // 15.5 days into a 31 day month -> exactly half way
    // Usage is 100, fixed is 50. Total spent = 150.
    // Usage should double to 200, fixed remains 50. Total = 250.
    const forecasted = calculateEomForecast(150, 50, now);
    expect(forecasted).toBe(250);
  });

  it("handles the very beginning of the month safely", () => {
    // Jan 1, 00:00 UTC (start of month)
    const now = new Date(Date.UTC(2025, 0, 1, 0, 5, 0));
    // 5 minutes into the month, avoid dividing by near zero
    const forecasted = calculateEomForecast(50, 50, now);
    expect(forecasted).toBe(50);
  });

  it("handles when spentUsd is less than fixed cost (should not happen but safely bounds)", () => {
    const now = new Date(Date.UTC(2025, 0, 15, 12, 0, 0));
    const forecasted = calculateEomForecast(20, 50, now);
    // Usage is max(0, 20 - 50) = 0. Forecast = 50 + 0 = 50.
    expect(forecasted).toBe(50);
  });
});
