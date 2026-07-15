import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardProviderWorkspace from "@/components/DashboardProviderWorkspace";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";

type WorkspaceProps = ComponentProps<typeof DashboardProviderWorkspace>;
type WorkspaceProvider = WorkspaceProps["providers"][number];
type WorkspaceSubscription = WorkspaceProps["subscriptions"][number];

function provider(
  id: string,
  overrides: Partial<WorkspaceProvider> = {}
): WorkspaceProvider {
  return {
    id,
    name: "anthropic",
    displayName: `Anthropic (${id})`,
    type: "builtin",
    isActive: true,
    groupId: "anthropic",
    label: id,
    estimatedMonthlyCostUsd: 0,
    projectedEomUsd: 0,
    spentUsd: 0,
    spendCoverage: "complete",
    pushedCostCoverage: "complete",
    pushedPricedEventCount: 1,
    pushedUnpricedEventCount: 0,
    pushedUnclassifiedCostEventCount: 0,
    plan: null,
    billingMode: "actual",
    alerts: [],
    latestSnapshot: null,
    ...overrides,
  };
}

function subscription(
  id: string,
  providerId: string,
  overrides: Partial<WorkspaceSubscription> = {}
): WorkspaceSubscription {
  return {
    id,
    name: id,
    description: null,
    costUsd: 10,
    currency: "USD",
    interval: "monthly",
    intervalCount: 1,
    monthlyEquivalentUsd: 10,
    anchorDay: null,
    startDate: "2098-01-01T00:00:00.000Z",
    currentPeriodStart: "2098-01-01T00:00:00.000Z",
    nextRenewalAt: "2099-02-01T00:00:00.000Z",
    autoRenew: true,
    status: "active",
    notes: null,
    externalBillingSource: null,
    externalBillingId: null,
    knobEnv: null,
    freeTierKnobEnv: null,
    provider: { id: providerId, name: "anthropic", displayName: "Anthropic" },
    project: null,
    ...overrides,
  };
}

function externalBilling(
  overrides: Partial<ExternalBillingRecord> = {}
): ExternalBillingRecord {
  return {
    source: "provider-api",
    externalId: "external-1",
    kind: "subscription",
    serviceName: "Provider plan",
    planName: "Pro",
    status: "active",
    amountUsd: 10,
    currency: "USD",
    billingInterval: "monthly",
    currentPeriodStart: "2099-01-01T00:00:00.000Z",
    currentPeriodEnd: "2099-02-01T00:00:00.000Z",
    nextRenewalAt: "2099-02-01T00:00:00.000Z",
    requestLimit: null,
    requestLimitWindow: null,
    spendLimitUsd: null,
    spendLimitWindow: null,
    rollupRole: "canonical",
    dateKind: "renewal",
    syncedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function renderWorkspace(
  providers: WorkspaceProvider[],
  subscriptions: WorkspaceSubscription[] = []
): string {
  return renderToStaticMarkup(
    createElement(DashboardProviderWorkspace, { providers, subscriptions })
  );
}

describe("DashboardProviderWorkspace", () => {
  it("reports unknown pending Gemini cost without presenting a false zero", () => {
    const html = renderWorkspace([
      provider("socratic-gemini", {
        name: "google-ai",
        displayName: "Google AI (SocraticTrade.com)",
        spentUsd: 0,
        projectedEomUsd: 0,
        spendCoverage: "unknown",
        pushedCostCoverage: "unknown",
        pushedPricedEventCount: 0,
        geminiBillingStatus: {
          state: "pending",
          errorCode: null,
          httpStatus: null,
          retryable: true,
          checkedAt: "2026-07-15T00:00:00.000Z",
        },
      }),
    ]);

    expect(html).toContain("Cost not reported");
    expect(html).toContain("Projection unavailable");
    expect(html).toContain(
      'aria-label="Google AI month-to-date spend: Cost not reported"'
    );
    expect(html).toContain(">Unknown</span>");
    expect(html).not.toContain("$0.00");
  });

  it("preserves an authoritative actual zero", () => {
    const html = renderWorkspace([
      provider("socratic-gemini", {
        name: "google-ai",
        displayName: "Google AI",
        spentUsd: 0,
        projectedEomUsd: 0,
        spendCoverage: "complete",
      }),
    ]);

    expect(html).toContain(
      'aria-label="Google AI month-to-date spend: $0.00"'
    );
    expect(html).toContain(">$0.00</p>");
    expect(html).toContain(">Complete</span>");
    expect(html).not.toContain("Cost not reported");
  });

  it("does not aggregate ambiguous same-family financial values", () => {
    const html = renderWorkspace([
      provider("account-one", {
        spentUsd: 100,
        receiptCashPaidUsd: 47.25,
        receiptCashEventCount: 3,
        observedVariableUsageUsd: 40,
        estimatedApiEquivalentUsd: 9_000,
        projectedEomUsd: 150,
        plan: {
          fixedMonthlyCostUsd: null,
          monthlyBudgetUsd: 50,
          monthlyRequestLimit: null,
          renewalDate: null,
          billingInterval: "monthly",
          notes: null,
        },
        latestSnapshot: {
          balance: 5,
          totalCost: 100,
          totalRequests: 10,
          credits: 10,
          fetchedAt: "2026-07-15T00:00:00.000Z",
        },
      }),
      provider("account-two", {
        spentUsd: 200,
        projectedEomUsd: 250,
        plan: {
          fixedMonthlyCostUsd: null,
          monthlyBudgetUsd: 75,
          monthlyRequestLimit: null,
          renewalDate: null,
          billingInterval: "monthly",
          notes: null,
        },
        latestSnapshot: {
          balance: 7,
          totalCost: 200,
          totalRequests: 20,
          credits: 20,
          fetchedAt: "2026-07-15T00:00:00.000Z",
        },
      }),
    ]);

    expect(html).toContain("Not aggregated");
    expect(html).toContain("$100.00 spent");
    expect(html).toContain("$47.25 receipt cash");
    expect(html).toContain("$9,000.00 Claude estimate excluded");
    expect(html).toContain("$200.00 spent");
    expect(html).toContain("$50.00 budget");
    expect(html).toContain("$75.00 budget");
    expect(html).toContain("10 credits / $5.00 balance");
    expect(html).toContain("20 credits / $7.00 balance");
    expect(html).not.toContain("$300.00");
    expect(html).not.toContain("$125.00");
    expect(html).not.toContain("$400.00");
    expect(html).not.toContain("30 credits");
    expect(html).not.toContain("$12.00 balance");
  });

  it("deduplicates linked provider billing and separates renewals from period and term ends", () => {
    const linkedRecord = externalBilling({
      source: "cloudflare-subscriptions",
      externalId: "pro-plan",
      serviceName: "SHOULD-NOT-RENDER",
      amountUsd: 19,
      currency: "EUR",
    });
    const periodRecord = externalBilling({
      externalId: "invoice-period",
      kind: "invoice",
      serviceName: "Usage period",
      status: "open",
      amountUsd: 5,
      currency: "EUR",
      dateKind: "period_end",
      nextRenewalAt: "2099-01-01T00:00:00.000Z",
    });
    const html = renderWorkspace(
      [
        provider("provider-one", {
          externalBilling: [linkedRecord, periodRecord, periodRecord],
        }),
        provider("provider-two"),
      ],
      [
        subscription("Cloudflare Pro", "provider-one", {
          costUsd: 19,
          currency: "EUR",
          monthlyEquivalentUsd: 19,
          externalBillingSource: "cloudflare-subscriptions",
          externalBillingId: "pro-plan",
        }),
        subscription("Ends with term", "provider-one", {
          autoRenew: false,
          nextRenewalAt: "2099-01-10T00:00:00.000Z",
        }),
        subscription("Canceled", "provider-one", {
          status: "canceled",
          nextRenewalAt: "2099-01-15T00:00:00.000Z",
        }),
        subscription("Expired term", "provider-one", {
          autoRenew: false,
          status: "active",
          effectiveStatus: "expired",
          nextRenewalAt: "2020-01-10T00:00:00.000Z",
        }),
      ]
    );

    expect(html).toContain("5 records");
    expect(html).not.toContain("SHOULD-NOT-RENDER");
    expect(html.match(/Usage period/g)).toHaveLength(1);
    expect(html).toContain("linked cloudflare-subscriptions");
    expect(html).toContain("Provider: Pro");
    expect(html).toContain("€19.00");
    expect(html).toContain("€5.00");
    expect(html).toContain("Period ends");
    expect(html).toContain("Term ends");
    expect(html).toContain("expired / monthly");
    expect(html).toContain("Term ended 1/10/2020");
    expect(html).toContain("Next renewal 2/1/2099");
  });

  it("collapses repeated accounts by default while preserving an accessible drill-down", () => {
    const html = renderWorkspace([
      provider("provider-one"),
      provider("provider-two"),
      provider("provider-three"),
      provider("provider-four"),
    ]);

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("4 accounts / keys");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="provider-family-details-provider-one"');
    expect(html).toContain(
      'aria-label="Show Anthropic account and service details"'
    );
    expect(html).toContain(
      'id="provider-family-details-provider-one" hidden="" style="display:none"'
    );
    expect(html).toContain("table-group-cell");
    expect(html.match(/data-label="Provider family"/g)).toHaveLength(1);
    for (const id of [
      "provider-one",
      "provider-two",
      "provider-three",
      "provider-four",
    ]) {
      expect(html).toContain(`href="/providers/${id}"`);
    }
  });
});
