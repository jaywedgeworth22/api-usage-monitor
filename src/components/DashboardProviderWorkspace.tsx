"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Search,
  Settings,
} from "lucide-react";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";
import type { ProviderCostCoverage } from "@/components/ProviderCard";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";

interface WorkspaceProvider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  isActive: boolean;
  groupId: string | null;
  label: string | null;
  keyPreview?: string | null;
  geminiKeyStatus?: {
    state: "valid" | "invalid" | "unreadable" | "unavailable" | "unchecked" | "not_configured";
    httpStatus: number | null;
    availableModelCount: number | null;
    checkedAt: string | null;
  } | null;
  geminiBillingStatus?: {
    state: "ready" | "pending" | "error" | "configuration_changed" | "unchecked" | "not_configured";
    errorCode: string | null;
    httpStatus: number | null;
    retryable: boolean;
    checkedAt: string | null;
  } | null;
  estimatedMonthlyCostUsd: number;
  projectedEomUsd: number;
  spentUsd?: number;
  spendCoverage: ProviderCostCoverage;
  pushedCostCoverage: ProviderCostCoverage;
  pushedPricedEventCount: number;
  pushedUnpricedEventCount: number;
  pushedUnclassifiedCostEventCount: number;
  externalBilling?: ExternalBillingRecord[];
  plan: {
    fixedMonthlyCostUsd: number | null;
    monthlyBudgetUsd: number | null;
    monthlyRequestLimit: number | null;
    renewalDate: string | null;
    billingInterval: string | null;
    notes: string | null;
  } | null;
  billingMode: "actual" | "estimated" | "manual";
  alerts: {
    severity: "critical" | "warning" | "info";
    message: string;
  }[];
  latestSnapshot: {
    balance: number | null;
    totalCost: number | null;
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
}

interface ProviderFamily {
  key: string;
  detailsId: string;
  displayName: string;
  providerName: string;
  providers: WorkspaceProvider[];
  subscriptions: SubscriptionRow[];
  providerExternalBilling: FamilyExternalBillingRecord[];
  searchableExternalBilling: FamilyExternalBillingRecord[];
  financialsAggregated: boolean;
  spentUsd: number | null;
  projectedUsd: number | null;
  budgetUsd: number | null;
  spendSortUsd: number;
  credits: number | null;
  balance: number | null;
  alertCount: number;
  criticalCount: number;
  activeCount: number;
  incompleteCostCount: number;
  nextRenewalAt: string | null;
  latestFetchedAt: string | null;
}

interface FamilyExternalBillingRecord {
  key: string;
  providerId: string;
  providerDisplayName: string;
  record: ExternalBillingRecord;
}

interface DashboardProviderWorkspaceProps {
  providers: WorkspaceProvider[];
  subscriptions: SubscriptionRow[];
}

type SortMode = "attention" | "spend" | "name" | "renewal";

function familyKey(provider: WorkspaceProvider): string {
  return provider.name.trim().toLowerCase() || provider.type.trim().toLowerCase() || provider.id;
}

function familyDisplayName(providers: WorkspaceProvider[]): string {
  const counts = new Map<string, number>();
  for (const provider of providers) {
    const name = provider.displayName.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? providers[0]?.displayName ?? "Provider";
}

function providerSpend(provider: WorkspaceProvider): number {
  return provider.spentUsd ?? provider.latestSnapshot?.totalCost ?? provider.estimatedMonthlyCostUsd ?? 0;
}

function latestDate(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestTime = 0;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time) && time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}

function earliestFutureDate(
  values: Array<string | null | undefined>,
  now: number
): string | null {
  let earliest: string | null = null;
  let earliestTime = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time) && time > now && time < earliestTime) {
      earliest = value;
      earliestTime = time;
    }
  }
  return earliest;
}

function formatCurrency(amount: number | null, currency = "USD"): string {
  if (amount == null) return "--";
  const normalizedCurrency = currency.trim().toUpperCase() || "UNKNOWN";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${normalizedCurrency}`;
  }
}

function formatNumber(amount: number | null): string {
  if (amount == null) return "--";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(amount);
}

function formatDate(value: string | null): string {
  if (!value) return "--";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "--";
  return new Date(time).toLocaleDateString(undefined, { timeZone: "UTC" });
}

function costCoverageLabel(family: ProviderFamily): string {
  if (!family.financialsAggregated) return "Not aggregated";
  if (family.incompleteCostCount === 0) return "Complete";
  if ((family.spentUsd ?? 0) > 0) return "Partial";
  return "Unknown";
}

function childLabel(provider: WorkspaceProvider): string {
  return provider.label || provider.keyPreview || provider.displayName;
}

function effectiveSubscriptionStatus(subscription: SubscriptionRow): string {
  return (subscription.effectiveStatus ?? subscription.status).trim().toLowerCase();
}

function externalBillingIdentity(
  providerId: string,
  record: ExternalBillingRecord
): string | null {
  const source = record.source.trim();
  const externalId = record.externalId?.trim();
  return source && externalId
    ? JSON.stringify([providerId, source, externalId])
    : null;
}

function subscriptionBillingIdentity(subscription: SubscriptionRow): string | null {
  const source = subscription.externalBillingSource?.trim();
  const externalId = subscription.externalBillingId?.trim();
  return source && externalId
    ? JSON.stringify([subscription.provider.id, source, externalId])
    : null;
}

function linkedExternalBillingRecord(
  family: ProviderFamily,
  subscription: SubscriptionRow
): ExternalBillingRecord | null {
  const identity = subscriptionBillingIdentity(subscription);
  if (!identity) return null;
  return family.searchableExternalBilling.find(
    ({ providerId, record }) =>
      externalBillingIdentity(providerId, record) === identity
  )?.record ?? null;
}

function isLiveExternalBillingStatus(status: string | null): boolean {
  return ["active", "enabled", "paid", "trialing"].includes(
    status?.trim().toLowerCase() ?? ""
  );
}

function isExternalBillingRenewal(record: ExternalBillingRecord): boolean {
  const kind = record.kind.trim().toLowerCase();
  const rollupRole = record.rollupRole?.trim().toLowerCase() ?? "canonical";
  const dateKind = record.dateKind?.trim().toLowerCase() ?? null;
  return (
    ["plan", "subscription"].includes(kind) &&
    rollupRole === "canonical" &&
    isLiveExternalBillingStatus(record.status) &&
    (dateKind == null || dateKind === "renewal")
  );
}

function subscriptionDateSummary(subscription: SubscriptionRow, now: number): string {
  const date = Date.parse(subscription.nextRenewalAt);
  if (!Number.isFinite(date)) return "No date reported";
  const formattedDate = formatDate(subscription.nextRenewalAt);
  const status = effectiveSubscriptionStatus(subscription);

  if (status === "active" && subscription.autoRenew && date > now) {
    return `Renews ${formattedDate}`;
  }
  if (status === "active" && !subscription.autoRenew && date > now) {
    return `Term ends ${formattedDate}`;
  }
  if (status === "expired" && !subscription.autoRenew) {
    return `Term ended ${formattedDate}`;
  }
  if (status === "active" && subscription.autoRenew) {
    return `Renewal date passed ${formattedDate}`;
  }
  return `No active renewal / term ${formattedDate}`;
}

function externalBillingDateSummary(
  record: ExternalBillingRecord,
  now: number
): string {
  const value = record.nextRenewalAt ?? record.currentPeriodEnd;
  if (!value) return "No date reported";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "No date reported";
  const date = formatDate(value);
  const dateKind = record.dateKind?.trim().toLowerCase() ?? null;
  const hasEnded = time <= now;

  if ((dateKind == null || dateKind === "renewal") && isExternalBillingRenewal(record)) {
    return time > now ? `Renews ${date}` : `Renewal date passed ${date}`;
  }
  switch (dateKind) {
    case "contract_end":
      return `Term ${hasEnded ? "ended" : "ends"} ${date}`;
    case "period_end":
      return `Period ${hasEnded ? "ended" : "ends"} ${date}`;
    case "quota_reset":
      return `Quota ${hasEnded ? "reset" : "resets"} ${date}`;
    case "report_through":
      return `Reported through ${date}`;
    default:
      return `Next reported date ${date}`;
  }
}

export default function DashboardProviderWorkspace({
  providers,
  subscriptions,
}: DashboardProviderWorkspaceProps) {
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("attention");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [referenceNow] = useState(() => Date.now());

  const families = useMemo<ProviderFamily[]>(() => {
    const providersByFamily = new Map<string, WorkspaceProvider[]>();
    for (const provider of providers) {
      const key = familyKey(provider);
      const group = providersByFamily.get(key);
      if (group) group.push(provider);
      else providersByFamily.set(key, [provider]);
    }

    return [...providersByFamily.entries()].map(([key, groupProviders]) => {
      const groupProviderIds = new Set(groupProviders.map((provider) => provider.id));
      const familySubscriptions = subscriptions.filter((subscription) =>
        groupProviderIds.has(subscription.provider.id)
      ).toSorted((a, b) => a.name.localeCompare(b.name));
      const linkedExternalBilling = new Set(
        familySubscriptions
          .map(subscriptionBillingIdentity)
          .filter((identity): identity is string => identity != null)
      );
      const seenExternalBilling = new Set<string>();
      const allProviderExternalBilling: FamilyExternalBillingRecord[] = [];
      for (const provider of groupProviders) {
        for (const [index, record] of (provider.externalBilling ?? []).entries()) {
          const canonicalIdentity = externalBillingIdentity(provider.id, record);
          const renderKey = canonicalIdentity ?? JSON.stringify([
            provider.id,
            record.source,
            record.kind,
            index,
          ]);
          if (seenExternalBilling.has(renderKey)) {
            continue;
          }
          seenExternalBilling.add(renderKey);
          allProviderExternalBilling.push({
            key: renderKey,
            providerId: provider.id,
            providerDisplayName: provider.displayName,
            record,
          });
        }
      }
      const providerExternalBilling = allProviderExternalBilling.filter(
        ({ providerId, record }) => {
          const identity = externalBillingIdentity(providerId, record);
          return identity == null || !linkedExternalBilling.has(identity);
        }
      );
      const orderedProviders = groupProviders.toSorted((a, b) =>
        a.displayName.localeCompare(b.displayName)
      );
      const financialsAggregated = groupProviders.length === 1;
      const onlyProvider = financialsAggregated ? groupProviders[0] : null;
      const spendValues = groupProviders.map(providerSpend);
      const externalRenewals = allProviderExternalBilling
        .filter(({ record }) => isExternalBillingRenewal(record))
        .map(({ record }) => record.nextRenewalAt);
      const subscriptionRenewals = familySubscriptions
        .filter(
          (subscription) =>
            effectiveSubscriptionStatus(subscription) === "active" &&
            subscription.autoRenew
        )
        .map((subscription) => subscription.nextRenewalAt);
      return {
        key,
        detailsId: `provider-family-details-${groupProviders[0]?.id ?? key}`,
        displayName: familyDisplayName(groupProviders),
        providerName: groupProviders[0]?.name ?? key,
        providers: orderedProviders,
        subscriptions: familySubscriptions,
        providerExternalBilling: providerExternalBilling.toSorted((a, b) =>
          (a.record.serviceName ?? a.record.planName ?? a.record.kind).localeCompare(
            b.record.serviceName ?? b.record.planName ?? b.record.kind
          )
        ),
        searchableExternalBilling: allProviderExternalBilling,
        financialsAggregated,
        spentUsd: onlyProvider ? providerSpend(onlyProvider) : null,
        projectedUsd: onlyProvider?.projectedEomUsd ?? null,
        budgetUsd: onlyProvider?.plan?.monthlyBudgetUsd ?? null,
        spendSortUsd: Math.max(0, ...spendValues),
        credits: onlyProvider?.latestSnapshot?.credits ?? null,
        balance: onlyProvider?.latestSnapshot?.balance ?? null,
        alertCount: groupProviders.reduce(
          (sum, provider) => sum + provider.alerts.filter((alert) => alert.severity !== "info").length,
          0
        ),
        criticalCount: groupProviders.reduce(
          (sum, provider) => sum + provider.alerts.filter((alert) => alert.severity === "critical").length,
          0
        ),
        activeCount: groupProviders.filter((provider) => provider.isActive).length,
        incompleteCostCount: groupProviders.filter((provider) => provider.isActive && provider.spendCoverage !== "complete").length,
        nextRenewalAt: earliestFutureDate(
          [...subscriptionRenewals, ...externalRenewals],
          referenceNow
        ),
        latestFetchedAt: latestDate(groupProviders.map((provider) => provider.latestSnapshot?.fetchedAt)),
      };
    });
  }, [providers, referenceNow, subscriptions]);

  const visibleFamilies = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
      ? families.filter((family) => {
          const haystack = [
            family.displayName,
            family.providerName,
            ...family.providers.flatMap((provider) => [
              provider.displayName,
              provider.label ?? "",
              provider.keyPreview ?? "",
              provider.type,
            ]),
            ...family.subscriptions.flatMap((subscription) => [
              subscription.name,
              subscription.description ?? "",
              subscription.currency,
              subscription.externalBillingSource ?? "",
              subscription.externalBillingId ?? "",
              subscription.project?.name ?? "",
            ]),
            ...family.searchableExternalBilling.flatMap(({ providerDisplayName, record }) => [
              providerDisplayName,
              record.source,
              record.externalId ?? "",
              record.kind,
              record.serviceName ?? "",
              record.planName ?? "",
              record.status ?? "",
              record.currency ?? "",
              record.billingInterval ?? "",
            ]),
          ].join(" ").toLowerCase();
          return haystack.includes(normalizedQuery);
        })
      : families;

    return filtered.toSorted((a, b) => {
      switch (sortMode) {
        case "spend":
          return b.spendSortUsd - a.spendSortUsd || a.displayName.localeCompare(b.displayName);
        case "name":
          return a.displayName.localeCompare(b.displayName);
        case "renewal": {
          const left = a.nextRenewalAt ? Date.parse(a.nextRenewalAt) : Number.POSITIVE_INFINITY;
          const right = b.nextRenewalAt ? Date.parse(b.nextRenewalAt) : Number.POSITIVE_INFINITY;
          return left - right || a.displayName.localeCompare(b.displayName);
        }
        case "attention":
        default:
          return (
            b.criticalCount - a.criticalCount ||
            b.alertCount - a.alertCount ||
            b.spendSortUsd - a.spendSortUsd ||
            a.displayName.localeCompare(b.displayName)
          );
      }
    });
  }, [families, query, sortMode]);

  if (providers.length === 0) {
    return (
      <section className="flex flex-col items-center justify-center gap-4 rounded-lg border border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-gray-800">
        <p className="text-gray-500 dark:text-gray-400">No providers configured yet.</p>
        <Link
          href="/settings"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Add your first provider
        </Link>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800" aria-labelledby="provider-workspace-heading">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-4 py-4 dark:border-gray-700 sm:px-6">
        <div>
          <h2 id="provider-workspace-heading" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Provider workspace
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-gray-500 dark:text-gray-400">
            {families.length} provider families, {providers.length} configured accounts, {subscriptions.length} tracked services.
          </p>
        </div>
        <Link href="/settings" className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
          <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          Settings
        </Link>
      </div>

      <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <label className="relative block min-w-0 flex-1 sm:max-w-md">
          <span className="sr-only">Search provider families</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search providers, accounts, keys, services"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:focus:ring-blue-950"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {([
            ["attention", "Attention"],
            ["spend", "Spend"],
            ["renewal", "Renewal"],
            ["name", "Name"],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={sortMode === mode}
              onClick={() => setSortMode(mode)}
              className={`rounded-lg px-3 py-2 text-xs font-semibold ${
                sortMode === mode
                  ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                  : "border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="responsive-table w-full text-sm">
          <caption className="sr-only">Provider families with expandable account, service, usage, quota, renewal, and alert rows</caption>
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60">
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 sm:px-6">Provider family</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Spend</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Credits / balance</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Services</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Health</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 sm:px-6">Last sync</th>
            </tr>
          </thead>
          <tbody>
            {visibleFamilies.map((family) => {
              const isCollapsed = collapsed[family.key] ?? family.providers.length === 1;
              return (
                <Fragment key={family.key}>
                  <tr className="border-b border-gray-100 align-top hover:bg-gray-50/70 dark:border-gray-700 dark:hover:bg-gray-700/40">
                    <td data-label="Provider family" className="px-4 py-4 sm:px-6">
                      <button
                        type="button"
                        aria-expanded={!isCollapsed}
                        aria-controls={family.detailsId}
                        onClick={() => setCollapsed((current) => ({ ...current, [family.key]: !isCollapsed }))}
                        className="flex min-w-0 items-start gap-2 text-left"
                      >
                        {isCollapsed ? (
                          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-gray-900 dark:text-gray-100">{family.displayName}</span>
                          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                            {family.providers.length} account{family.providers.length === 1 ? "" : "s"} / key{family.providers.length === 1 ? "" : "s"}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td data-label="Spend" className="px-4 py-4">
                      {family.financialsAggregated ? (
                        <>
                          <p className="font-semibold text-gray-900 dark:text-gray-100">{formatCurrency(family.spentUsd)}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {family.budgetUsd != null
                              ? `${formatCurrency(family.budgetUsd)} budget`
                              : `${formatCurrency(family.projectedUsd)} projected`}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="font-semibold text-gray-900 dark:text-gray-100">Not aggregated</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            See exact account values below
                          </p>
                        </>
                      )}
                      <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        family.financialsAggregated && family.incompleteCostCount === 0
                          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                          : "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                      }`}>
                        {costCoverageLabel(family)}
                      </span>
                    </td>
                    <td data-label="Credits / balance" className="px-4 py-4">
                      {family.financialsAggregated ? (
                        <>
                          <p className="font-medium text-gray-800 dark:text-gray-200">{formatNumber(family.credits)} credits</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">{formatCurrency(family.balance)} balance</p>
                        </>
                      ) : (
                        <>
                          <p className="font-medium text-gray-800 dark:text-gray-200">Per account</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">No duplicate totals</p>
                        </>
                      )}
                    </td>
                    <td data-label="Services" className="px-4 py-4">
                      <p className="font-medium text-gray-800 dark:text-gray-200">
                        {family.subscriptions.length + family.providerExternalBilling.length} record{family.subscriptions.length + family.providerExternalBilling.length === 1 ? "" : "s"}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {family.nextRenewalAt
                          ? `Next renewal ${formatDate(family.nextRenewalAt)}`
                          : "No active future renewal"}
                      </p>
                    </td>
                    <td data-label="Health" className="px-4 py-4">
                      {family.alertCount > 0 ? (
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          family.criticalCount > 0
                            ? "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300"
                            : "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                        }`}>
                          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                          {family.alertCount} alert{family.alertCount === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                          Clear
                        </span>
                      )}
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{family.activeCount} active</p>
                    </td>
                    <td data-label="Last sync" className="px-4 py-4 sm:px-6">
                      <p className="font-medium text-gray-800 dark:text-gray-200">{formatDate(family.latestFetchedAt)}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{family.providerName}</p>
                    </td>
                  </tr>
                  {!isCollapsed && (
                    <tr
                      id={family.detailsId}
                      className="border-b border-gray-100 bg-gray-50/70 dark:border-gray-700 dark:bg-gray-900/30"
                    >
                      <td colSpan={6} className="table-group-cell px-4 py-3 sm:px-6">
                        <div className="grid gap-2 lg:grid-cols-2">
                          {family.providers.map((provider) => (
                            <Link
                              key={provider.id}
                              href={`/providers/${provider.id}`}
                              className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-3 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600"
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{childLabel(provider)}</span>
                                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                                  {provider.keyPreview && (
                                    <span className="inline-flex items-center gap-1 font-mono">
                                      <KeyRound className="h-3 w-3" aria-hidden="true" />
                                      {provider.keyPreview}
                                    </span>
                                  )}
                                  {provider.geminiKeyStatus && <span>{provider.geminiKeyStatus.state.replaceAll("_", " ")}</span>}
                                  {provider.geminiBillingStatus && <span>{provider.geminiBillingStatus.state.replaceAll("_", " ")}</span>}
                                </span>
                              </span>
                              <span className="shrink-0 text-right">
                                <span className="block text-sm font-semibold text-gray-900 dark:text-gray-100">{formatCurrency(providerSpend(provider))} spent</span>
                                <span className="block text-xs text-gray-500 dark:text-gray-400">
                                  {formatCurrency(provider.projectedEomUsd)} projected
                                </span>
                                <span className="block text-xs text-gray-500 dark:text-gray-400">
                                  {formatCurrency(provider.plan?.monthlyBudgetUsd ?? null)} budget
                                </span>
                                <span className="block text-xs text-gray-500 dark:text-gray-400">
                                  {formatNumber(provider.latestSnapshot?.credits ?? null)} credits / {formatCurrency(provider.latestSnapshot?.balance ?? null)} balance
                                </span>
                                {provider.plan?.renewalDate && (
                                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                                    Plan renewal {formatDate(provider.plan.renewalDate)}
                                  </span>
                                )}
                                <span className="block text-xs text-gray-500 dark:text-gray-400">
                                  {provider.alerts.filter((alert) => alert.severity !== "info").length} alerts
                                </span>
                              </span>
                            </Link>
                          ))}
                          {family.subscriptions.map((subscription) => {
                            const linkedRecord = linkedExternalBillingRecord(
                              family,
                              subscription
                            );
                            return (
                              <Link
                                key={subscription.id}
                                href="/settings?tab=services"
                                className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-3 hover:border-blue-200 dark:border-blue-900 dark:bg-blue-950/30 dark:hover:border-blue-800"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-semibold text-blue-950 dark:text-blue-100">{subscription.name}</span>
                                  <span className="mt-0.5 block text-xs text-blue-700 dark:text-blue-300">
                                    {subscription.status} / {subscription.intervalCount === 1 ? subscription.interval : `${subscription.intervalCount} ${subscription.interval}`}
                                    {subscription.externalBillingSource
                                      ? ` / linked ${subscription.externalBillingSource}`
                                      : ""}
                                  </span>
                                  {linkedRecord && (
                                    <span className="mt-0.5 block text-xs text-blue-700 dark:text-blue-300">
                                      Provider: {linkedRecord.planName || linkedRecord.serviceName || linkedRecord.kind} / {externalBillingDateSummary(linkedRecord, referenceNow)}
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 text-right">
                                  <span className="block text-sm font-semibold text-blue-950 dark:text-blue-100">
                                    {formatCurrency(subscription.costUsd, subscription.currency)}
                                  </span>
                                  <span className="block text-xs text-blue-700 dark:text-blue-300">
                                    {subscriptionDateSummary(subscription, referenceNow)}
                                  </span>
                                </span>
                              </Link>
                            );
                          })}
                          {family.providerExternalBilling.map(({ key, providerId, providerDisplayName, record }) => (
                            <Link
                              key={key}
                              href={`/providers/${providerId}`}
                              className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-violet-100 bg-violet-50 px-3 py-3 hover:border-violet-200 dark:border-violet-900 dark:bg-violet-950/30 dark:hover:border-violet-800"
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-violet-950 dark:text-violet-100">
                                  {record.serviceName || record.planName || record.kind}
                                </span>
                                <span className="mt-0.5 block text-xs text-violet-700 dark:text-violet-300">
                                  {providerDisplayName} / {record.source} / {record.kind}
                                  {record.planName ? ` / ${record.planName}` : ""}
                                  {record.status ? ` / ${record.status}` : ""}
                                </span>
                              </span>
                              <span className="shrink-0 text-right">
                                <span className="block text-sm font-semibold text-violet-950 dark:text-violet-100">
                                  {formatCurrency(record.amountUsd, record.currency ?? "USD")}
                                  {record.billingInterval ? ` / ${record.billingInterval}` : ""}
                                </span>
                                <span className="block text-xs text-violet-700 dark:text-violet-300">
                                  {externalBillingDateSummary(record, referenceNow)}
                                </span>
                              </span>
                            </Link>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {visibleFamilies.length === 0 && (
        <div className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400 sm:px-6">
          No provider families match the current search.
        </div>
      )}
    </section>
  );
}
