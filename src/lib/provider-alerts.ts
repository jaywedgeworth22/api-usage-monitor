import { calculateEomForecast } from "@/lib/forecasting";
import { type AnomalyResult, describeAnomaly } from "@/lib/anomaly-detection";
import { isSubscriptionInterval, rollForwardRenewal } from "@/lib/subscriptions";

export type AlertSeverity = "critical" | "warning" | "info";

export interface ProviderAlert {
  code:
    | "budget_exceeded"
    | "budget_warning"
    | "fixed_cost_conflict"
    | "billing_sync_incomplete"
    | "balance_low"
    | "credits_low"
    | "request_limit"
    | "request_limit_warning"
    | "renewal_overdue"
    | "renewal_due"
    | "missing_balance_visibility"
    | "stale_snapshot"
    | "missing_snapshot"
    | "unconfigured_budget"
    | "usage_reconciliation_discrepancy"
    // Statistical spike/anomaly alerts (see anomaly-detection.ts). Consumed by
    // the generic providerId:code alert-delivery machinery like any other code.
    | "spend_anomaly"
    | "request_anomaly"
    // Advisory codes emitted by the budget-breach control layer (see
    // budget-controls.ts / budget-status.ts). budget_control_paused surfaces a
    // provider whose polling was auto-paused on a sustained budget breach;
    // key_disable_recommended is advisory only and never reflects a credential
    // mutation. Produced in budget-status.ts, not here — this file only carries
    // the code names.
    | "budget_control_paused"
    | "key_disable_recommended";
  severity: AlertSeverity;
  message: string;
}

export interface ProviderPlanForAlerts {
  billingMode: string;
  fixedMonthlyCostUsd: number | null;
  monthlyBudgetUsd: number | null;
  monthlyRequestLimit: number | null;
  lowBalanceUsd: number | null;
  lowCredits: number | null;
  renewalDate: Date | string | null;
  billingInterval?: string | null;
  mustKeepFunded: boolean;
}

export interface UsageSnapshotForAlerts {
  balance: number | null;
  totalCost: number | null;
  totalRequests: number | null;
  credits: number | null;
  fetchedAt: Date | string;
}

export type BudgetAlertTier = "ok" | "warning" | "exceeded";

export interface ProviderAlertInput {
  isActive: boolean;
  refreshIntervalMin: number;
  /** False for push/manual rows where a poll snapshot cannot exist. */
  snapshotExpected?: boolean;
  plan: ProviderPlanForAlerts | null;
  latestSnapshot: UsageSnapshotForAlerts | null;
  // Canonical month-to-date spend across poll, pushed usage, subscriptions,
  // and configured fixed cost. When omitted, preserve the legacy snapshot
  // calculation for pure/unit-test callers.
  trackedSpendUsd?: number;
  // Portion of trackedSpendUsd that is already a discrete/fixed charge and
  // must not be linearly extrapolated to month end.
  fixedAccruedUsd?: number;
  reconciliationDiscrepancyUsd?: number | null;
  // Pre-computed statistical anomalies (see anomaly-detection.ts /
  // anomaly-loader.ts). The detector runs upstream; this layer only maps each
  // structured result into an alert so the existing persistence/delivery/dedup
  // machinery carries it. Absent for callers that do not run detection.
  anomalies?: AnomalyResult[];
  /**
   * Prior budget tier for hysteresis (Wave C / C9). When omitted, enter
   * thresholds apply (80% warn / 100% exceed). When present, clear thresholds
   * are lower (75% / 95%) so spend oscillating around a boundary does not flap.
   */
  previousBudgetTier?: BudgetAlertTier;
}

export interface ProviderAlertState {
  alerts: ProviderAlert[];
  estimatedMonthlyCostUsd: number;
  projectedEomUsd: number;
  billingMode: "actual" | "estimated" | "manual";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Enter budget_warning at or above this ratio of monthly budget. */
const WARNING_ENTER_RATIO = 0.8;
/** Stay in warning until spend drops below this (hysteresis clear). */
const WARNING_CLEAR_RATIO = 0.75;
/** Stay in exceeded until spend drops below this (hysteresis clear). */
const EXCEEDED_CLEAR_RATIO = 0.95;
const RENEWAL_WARNING_DAYS = 7;

/**
 * Map spend/budget ratio to a budget alert tier with optional hysteresis.
 * Pure so unit tests can cover flap-free transitions without DB state.
 */
export function resolveBudgetAlertTier(
  spendUsd: number,
  budgetUsd: number,
  previous: BudgetAlertTier = "ok"
): BudgetAlertTier {
  if (!(budgetUsd > 0) || !Number.isFinite(spendUsd)) {
    return "ok";
  }
  const ratio = spendUsd / budgetUsd;
  if (previous === "exceeded") {
    if (ratio >= EXCEEDED_CLEAR_RATIO) return "exceeded";
    if (ratio >= WARNING_CLEAR_RATIO) return "warning";
    return "ok";
  }
  if (previous === "warning") {
    if (ratio >= 1) return "exceeded";
    if (ratio >= WARNING_CLEAR_RATIO) return "warning";
    return "ok";
  }
  if (ratio >= 1) return "exceeded";
  if (ratio >= WARNING_ENTER_RATIO) return "warning";
  return "ok";
}

export function providerSnapshotStaleAt(
  fetchedAt: Date | string,
  refreshIntervalMin: number
): Date {
  const staleAfterMs = Math.max(
    refreshIntervalMin * 3 * 60 * 1000,
    MS_PER_DAY
  );
  return new Date(new Date(fetchedAt).getTime() + staleAfterMs);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function normalizeBillingMode(value: string | undefined): ProviderAlertState["billingMode"] {
  if (value === "actual" || value === "estimated" || value === "manual") {
    return value;
  }
  return "manual";
}

export function buildProviderAlertState(
  input: ProviderAlertInput,
  now = new Date()
): ProviderAlertState {
  const alerts: ProviderAlert[] = [];
  const { plan, latestSnapshot } = input;
  const fixedMonthlyCost = plan?.fixedMonthlyCostUsd ?? 0;
  const usageCost = latestSnapshot?.totalCost ?? 0;
  const estimatedMonthlyCostUsd = input.trackedSpendUsd ?? fixedMonthlyCost + usageCost;
  const projectedEomUsd = calculateEomForecast(
    estimatedMonthlyCostUsd,
    input.fixedAccruedUsd ?? fixedMonthlyCost,
    now
  );
  const billingMode = normalizeBillingMode(plan?.billingMode);

  if (!input.isActive) {
    return { alerts, estimatedMonthlyCostUsd, projectedEomUsd, billingMode };
  }

  if (!plan) {
    alerts.push({
      code: "unconfigured_budget",
      severity: "info",
      message: "No budget, renewal, or limit metadata configured.",
    });
  }

  if (input.snapshotExpected !== false) {
    if (!latestSnapshot) {
      alerts.push({
        code: "missing_snapshot",
        severity: "warning",
        message: "No usage snapshot has been fetched yet.",
      });
    } else {
      const fetchedAt = new Date(latestSnapshot.fetchedAt);
      if (
        now.getTime() >
        providerSnapshotStaleAt(fetchedAt, input.refreshIntervalMin).getTime()
      ) {
        alerts.push({
          code: "stale_snapshot",
          severity: "warning",
          message: "Latest usage snapshot is stale.",
        });
      }
    }
  }

  if (plan?.monthlyBudgetUsd != null && plan.monthlyBudgetUsd > 0) {
    const budgetTier = resolveBudgetAlertTier(
      estimatedMonthlyCostUsd,
      plan.monthlyBudgetUsd,
      input.previousBudgetTier ?? "ok"
    );
    if (budgetTier === "exceeded") {
      alerts.push({
        code: "budget_exceeded",
        severity: "critical",
        message: `${formatUsd(estimatedMonthlyCostUsd)} tracked against ${formatUsd(
          plan.monthlyBudgetUsd
        )} monthly budget.`,
      });
    } else if (budgetTier === "warning") {
      alerts.push({
        code: "budget_warning",
        severity: "warning",
        message: `${formatUsd(estimatedMonthlyCostUsd)} tracked against ${formatUsd(
          plan.monthlyBudgetUsd
        )} monthly budget.`,
      });
    }
  }

  if (latestSnapshot?.totalRequests != null && plan?.monthlyRequestLimit) {
    // Request-limit hysteresis mirrors budget: clear below 95% / 75% when
    // previously open so delivery does not flap on boundary noise.
    const requestTier = resolveBudgetAlertTier(
      latestSnapshot.totalRequests,
      plan.monthlyRequestLimit,
      // Map prior request alerts if caller passed budget tier only — keep
      // enter/clear pure on current ratio without prior when unknown.
      "ok"
    );
    if (requestTier === "exceeded") {
      alerts.push({
        code: "request_limit",
        severity: "critical",
        message: `${formatNumber(latestSnapshot.totalRequests)} requests against ${formatNumber(
          plan.monthlyRequestLimit
        )} monthly limit.`,
      });
    } else if (requestTier === "warning") {
      alerts.push({
        code: "request_limit_warning",
        severity: "warning",
        message: `${formatNumber(latestSnapshot.totalRequests)} requests against ${formatNumber(
          plan.monthlyRequestLimit
        )} monthly limit.`,
      });
    }
  }

  const balanceFloor = plan?.lowBalanceUsd ?? (plan?.mustKeepFunded ? 0 : null);
  if (latestSnapshot?.balance != null && balanceFloor != null) {
    if (latestSnapshot.balance <= balanceFloor) {
      alerts.push({
        code: "balance_low",
        severity: latestSnapshot.balance <= 0 || plan?.mustKeepFunded ? "critical" : "warning",
        message: `Balance ${formatUsd(latestSnapshot.balance)} is at or below ${formatUsd(
          balanceFloor
        )}.`,
      });
    }
  } else if (plan?.mustKeepFunded && latestSnapshot?.balance == null) {
    alerts.push({
      code: "missing_balance_visibility",
      severity: "warning",
      message: "Marked must-keep-funded, but no balance is visible.",
    });
  }

  if (
    latestSnapshot?.credits != null &&
    plan?.lowCredits != null &&
    latestSnapshot.credits <= plan.lowCredits
  ) {
    alerts.push({
      code: "credits_low",
      severity: "warning",
      message: `${formatNumber(latestSnapshot.credits)} credits at or below ${formatNumber(
        plan.lowCredits
      )}.`,
    });
  }

  if (plan?.renewalDate) {
    const rawRenewal = new Date(plan.renewalDate);
    // When a cadence is known, roll a past renewalDate forward to the next
    // upcoming occurrence so a recurring plan never reads as permanently
    // "overdue" once its date passes (the persisted date is advanced on the
    // maintenance cycle — see rollForwardProviderRenewals). Without a cadence
    // there is nothing to advance to, so a past date is genuinely overdue.
    const interval =
      plan.billingInterval && isSubscriptionInterval(plan.billingInterval)
        ? plan.billingInterval
        : null;
    const renewal = interval ? rollForwardRenewal(rawRenewal, interval, 1, now) : rawRenewal;
    const daysUntilRenewal = Math.ceil(
      (renewal.getTime() - now.getTime()) / MS_PER_DAY
    );
    if (daysUntilRenewal < 0) {
      alerts.push({
        code: "renewal_overdue",
        severity: "critical",
        message: "Plan renewal date has passed.",
      });
    } else if (daysUntilRenewal <= RENEWAL_WARNING_DAYS) {
      alerts.push({
        code: "renewal_due",
        severity: "warning",
        message: `Plan renews in ${daysUntilRenewal} day${
          daysUntilRenewal === 1 ? "" : "s"
        }.`,
      });
    }
  }

  if (input.reconciliationDiscrepancyUsd != null && Math.abs(input.reconciliationDiscrepancyUsd) > 0.01) {
    alerts.push({
      code: "usage_reconciliation_discrepancy",
      severity: "warning",
      message: `Usage reconciliation discrepancy of ${formatUsd(input.reconciliationDiscrepancyUsd)} detected.`,
    });
  }

  // Emit statistical spike/anomaly alerts from pre-computed detector results.
  // The heavy lifting (baseline, robustness, thresholds) lives in
  // anomaly-detection.ts; here we only translate each result into an alert.
  for (const anomaly of input.anomalies ?? []) {
    alerts.push({
      code: anomaly.metric === "requests" ? "request_anomaly" : "spend_anomaly",
      severity: anomaly.severity,
      message: describeAnomaly(anomaly),
    });
  }

  return { alerts, estimatedMonthlyCostUsd, projectedEomUsd, billingMode };
}
