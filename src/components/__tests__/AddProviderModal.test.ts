import { describe, expect, it } from "vitest";
import {
  actualUsageBillingPlan,
  type ProviderPlan,
  withoutGoogleBillingConfig,
} from "@/components/AddProviderModal";

describe("AddProviderModal billing normalization", () => {
  it("preserves manual price and renewal facts until actual billing is reconciled", () => {
    const manualPlan: ProviderPlan = {
      billingMode: "manual",
      fixedMonthlyCostUsd: 25,
      monthlyBudgetUsd: 100,
      monthlyRequestLimit: 10_000,
      lowBalanceUsd: 5,
      lowCredits: null,
      renewalDate: "2026-08-01",
      billingInterval: "monthly",
      mustKeepFunded: true,
      notes: "Preserve non-charge settings",
    };

    expect(actualUsageBillingPlan(manualPlan)).toEqual({
      ...manualPlan,
      billingMode: "actual",
    });
    expect(manualPlan).toMatchObject({
      billingMode: "manual",
      fixedMonthlyCostUsd: 25,
      renewalDate: "2026-08-01",
    });
  });

  it("removes only Google billing connection fields", () => {
    const config = {
      billingDataset: "billing-project.billing_export",
      googleProjectId: "gemini-production",
      billingTable: "gcp_billing_export_v1_ABC",
      serviceAccountJson: "secret-json",
      statusKeyRef: "gemini-primary",
      unrelated: "keep-me",
    };

    expect(withoutGoogleBillingConfig(config)).toEqual({
      statusKeyRef: "gemini-primary",
      unrelated: "keep-me",
    });
    expect(config).toHaveProperty("serviceAccountJson", "secret-json");
  });
});
