import { describe, expect, it } from "vitest";

import {
  aggregateProviderFamilyMoney,
  aggregateProviderPortfolioMoney,
  type ProviderMoneyMember,
} from "@/lib/provider-money-aggregation";

const NOW = new Date("2026-07-18T12:00:00.000Z");

function member(
  id: string,
  overrides: Partial<ProviderMoneyMember> = {}
): ProviderMoneyMember {
  return {
    id,
    name: "openai",
    groupId: "openai",
    billingAccount: {
      matchKey: "billing-account-1",
      evidence: "shared_credential",
    },
    spentUsd: 23.67196375,
    projectedEomUsd: 40,
    snapshotCostUsd: 23.67196375,
    snapshotCostFetchedAt: "2026-07-18T11:00:00.000Z",
    snapshotFixedCostIncludedUsd: 0,
    pushedMonthToDateUsd: 0,
    receiptCashPaidUsd: 0,
    subscriptionMonthToDateUsd: 0,
    fixedMonthlyCostUsd: 0,
    linkedFixedDedupeUsd: 0,
    forecastedSubscriptionRenewalsUsd: 0,
    ...overrides,
  };
}

describe("provider billing-account money aggregation", () => {
  it("counts one canonical organization snapshot once and preserves distinct pushed app cost", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("st"),
        member("ct", {
          spentUsd: 27.8837226,
          pushedMonthToDateUsd: 27.8837226,
        }),
      ],
      NOW
    );

    expect(result).toMatchObject({
      exact: true,
      accountCount: 1,
      spentUsd: 27.8837226,
      ambiguity: "none",
    });
    expect(result.projectedEomUsd).toBeGreaterThan(result.spentUsd!);
    expect(result.spentUsd).not.toBeCloseTo(47.3439275);
    expect(result.spentUsd).not.toBeCloseTo(51.55568635);
  });

  it("sums provably different explicit provider accounts", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("account-a", {
          billingAccount: {
            matchKey: "billing-account-a",
            evidence: "explicit_account",
          },
          snapshotCostUsd: 12,
          spentUsd: 12,
        }),
        member("account-b", {
          billingAccount: {
            matchKey: "billing-account-b",
            evidence: "explicit_account",
          },
          snapshotCostUsd: 8,
          spentUsd: 8,
        }),
      ],
      NOW
    );

    expect(result).toMatchObject({
      exact: true,
      accountCount: 2,
      spentUsd: 20,
    });
  });

  it("does not treat different credentials as proof of different accounts", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("key-a"),
        member("key-b", {
          billingAccount: {
            matchKey: "billing-account-2",
            evidence: "shared_credential",
          },
        }),
      ],
      NOW
    );

    expect(result).toEqual({
      exact: false,
      spentUsd: null,
      projectedEomUsd: null,
      accountCount: null,
      ambiguity: "account_overlap_unproven",
    });
  });

  it("fails unresolved when same-account snapshots have incompatible billing windows", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("st", {
          snapshotCostWindowStart: "2026-07-01T00:00:00.000Z",
          snapshotCostWindowEnd: "2026-07-18T10:00:00.000Z",
          snapshotCostScope: "month_to_date",
        }),
        member("ct", {
          snapshotCostFetchedAt: "2026-07-18T11:30:00.000Z",
          snapshotCostWindowStart: "2026-07-15T00:00:00.000Z",
          snapshotCostWindowEnd: "2026-07-18T11:00:00.000Z",
          snapshotCostScope: "month_to_date",
        }),
      ],
      NOW
    );
    expect(result).toMatchObject({
      exact: false,
      ambiguity: "account_overlap_unproven",
    });
  });

  it("uses the latest compatible cumulative snapshot for one exact account", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("older", {
          snapshotCostUsd: 10,
          snapshotCostFetchedAt: "2026-07-18T10:00:00.000Z",
          snapshotCostWindowStart: "2026-07-01T00:00:00.000Z",
          snapshotCostWindowEnd: "2026-07-18T09:59:00.000Z",
          snapshotCostScope: "month_to_date",
        }),
        member("latest", {
          snapshotCostUsd: 12,
          snapshotCostFetchedAt: "2026-07-18T11:00:00.000Z",
          snapshotCostWindowStart: "2026-07-01T00:00:00.000Z",
          snapshotCostWindowEnd: "2026-07-18T10:59:00.000Z",
          snapshotCostScope: "MONTH_TO_DATE",
        }),
      ],
      NOW
    );
    expect(result).toMatchObject({ exact: true, spentUsd: 12 });
  });

  it("fails closed when any multi-row member lacks account identity", () => {
    const result = aggregateProviderFamilyMoney(
      [member("known"), member("missing", { billingAccount: null })],
      NOW
    );
    expect(result.exact).toBe(false);
    expect(result.ambiguity).toBe("account_identity_missing");
  });

  it("dedupes only the canonical fixed snapshot and keeps exact local fixed sources additive", () => {
    const result = aggregateProviderFamilyMoney(
      [
        member("st", {
          snapshotCostUsd: 15,
          snapshotFixedCostIncludedUsd: 5,
          subscriptionMonthToDateUsd: 5,
          pushedMonthToDateUsd: 5,
          linkedFixedDedupeUsd: 5,
          fixedMonthlyCostUsd: 3,
        }),
        member("ct", {
          snapshotCostUsd: 15,
          snapshotFixedCostIncludedUsd: 5,
          subscriptionMonthToDateUsd: 2,
          pushedMonthToDateUsd: 6,
        }),
      ],
      NOW
    );

    // variable=max($10 canonical, $4 pushed); fixed=$3+$5+$2+$5-$5.
    expect(result.spentUsd).toBe(20);
  });

  it("ignores non-additive component records because only canonical budget fields enter the formula", () => {
    const baseline = member("one", { snapshotCostUsd: 9 });
    const withComponents = {
      ...baseline,
      externalBilling: [
        { rollupRole: "component", amountUsd: 1000 },
        { rollupRole: "component", amountUsd: 2000 },
      ],
    } as ProviderMoneyMember;
    expect(aggregateProviderFamilyMoney([withComponents], NOW).spentUsd).toBe(
      aggregateProviderFamilyMoney([baseline], NOW).spentUsd
    );
  });

  it("uses exact account totals in portfolio spend/projection and excludes only unresolved families", () => {
    const providers = [
      member("st"),
      member("ct", {
        pushedMonthToDateUsd: 27.8837226,
        spentUsd: 27.8837226,
      }),
      member("github", {
        name: "github",
        groupId: null,
        billingAccount: null,
        spentUsd: 5,
        projectedEomUsd: 7,
        snapshotCostUsd: null,
      }),
      member("ambiguous-a", {
        name: "google-ai",
        billingAccount: null,
      }),
      member("ambiguous-b", {
        name: "google-ai",
        billingAccount: null,
      }),
    ];
    const result = aggregateProviderPortfolioMoney(providers, NOW);
    const openAi = aggregateProviderFamilyMoney(providers.slice(0, 2), NOW);

    expect(result.totalCost).toBeCloseTo(openAi.spentUsd! + 5);
    expect(result.totalProjectedMonthlyCost).toBeCloseTo(
      openAi.projectedEomUsd! + 7
    );
    expect(result.ambiguousCostFamilyCount).toBe(1);
  });
});
