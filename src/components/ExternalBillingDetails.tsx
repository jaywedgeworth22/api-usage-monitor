import { externalBillingFreshnessWindowMs } from "@/lib/external-billing-link";

export interface ExternalBillingRecord {
  source: string;
  externalId: string | null;
  kind: string;
  serviceName?: string | null;
  planName: string | null;
  status: string | null;
  amountUsd: number | null;
  currency: string | null;
  billingInterval: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextRenewalAt: string | null;
  requestLimit: number | null;
  requestLimitWindow: string | null;
  spendLimitUsd: number | null;
  spendLimitWindow: string | null;
  usageQuantity?: number | null;
  remainingQuantity?: number | null;
  usageUnit?: string | null;
  rollupRole?: string | null;
  dateKind?: string | null;
  syncedAt: string;
}

export function isExternalBillingStale(
  record: Pick<ExternalBillingRecord, "syncedAt">,
  staleAfterMs = externalBillingFreshnessWindowMs(),
  now = Date.now()
): boolean {
  const syncedAt = Date.parse(record.syncedAt);
  return !Number.isFinite(syncedAt) || now - syncedAt > staleAfterMs;
}

function formatCurrency(amount: number, currency: string | null): string {
  const normalizedCurrency = currency?.trim().toUpperCase() || "UNKNOWN";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${normalizedCurrency}`;
  }
}

function formatDate(value: string | null): string {
  return value
    ? new Date(value).toLocaleDateString(undefined, { timeZone: "UTC" })
    : "--";
}

function statusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (["active", "paid", "trialing", "enabled"].includes(normalized)) {
    return "bg-emerald-50 text-emerald-700";
  }
  if (["past_due", "past-due", "warning", "paused"].includes(normalized)) {
    return "bg-amber-50 text-amber-700";
  }
  if (["canceled", "cancelled", "unpaid", "disabled"].includes(normalized)) {
    return "bg-red-50 text-red-700";
  }
  return "bg-gray-100 text-gray-700";
}

export default function ExternalBillingDetails({
  records,
  refreshIntervalMin = 60,
}: {
  records: ExternalBillingRecord[];
  refreshIntervalMin?: number;
}) {
  if (records.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-xl border border-blue-200 bg-white" aria-labelledby="provider-billing-heading">
      <div className="border-b border-blue-100 bg-blue-50 px-4 py-3 sm:px-6">
        <h2 id="provider-billing-heading" className="text-sm font-semibold text-blue-800">
          Provider-reported billing
        </h2>
        <p className="mt-0.5 text-xs text-blue-700">
          Read-only data synced from the provider. It does not create or duplicate local Subscription charges.
        </p>
      </div>
      <div className="divide-y divide-gray-100">
        {records.map((record, index) => (
          <article key={`${record.source}-${record.externalId ?? record.kind}-${index}`} className="space-y-3 px-4 py-4 sm:px-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium text-gray-900">{record.serviceName || record.planName || record.kind}</p>
                {record.serviceName && record.planName && (
                  <p className="text-xs text-gray-600">{record.planName}</p>
                )}
                <p className="text-xs text-gray-500">{record.source} · {record.kind}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {isExternalBillingStale(
                  record,
                  externalBillingFreshnessWindowMs(refreshIntervalMin)
                ) && (
                  <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800">
                    stale sync
                  </span>
                )}
                {record.status && (
                  <span className={`rounded-full px-2 py-1 text-xs font-medium ${statusClass(record.status)}`}>
                    {record.status}
                  </span>
                )}
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
              <div>
                <dt className="text-xs text-gray-500">Reported amount</dt>
                <dd className="mt-0.5 font-medium text-gray-900">
                  {record.amountUsd == null ? "--" : formatCurrency(record.amountUsd, record.currency)}
                  {record.billingInterval ? ` / ${record.billingInterval}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Current period</dt>
                <dd className="mt-0.5 text-gray-700">
                  {formatDate(record.currentPeriodStart)} – {formatDate(record.currentPeriodEnd)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Next renewal</dt>
                <dd className="mt-0.5 text-gray-700">{formatDate(record.nextRenewalAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Request limit</dt>
                <dd className="mt-0.5 text-gray-700">
                  {record.requestLimit == null
                    ? "--"
                    : `${new Intl.NumberFormat("en-US").format(record.requestLimit)}${
                        record.requestLimitWindow ? ` / ${record.requestLimitWindow}` : ""
                      }`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Spend limit</dt>
                <dd className="mt-0.5 text-gray-700">
                  {record.spendLimitUsd == null
                    ? "--"
                    : `${formatCurrency(record.spendLimitUsd, "USD")}${
                        record.spendLimitWindow ? ` / ${record.spendLimitWindow}` : ""
                      }`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Last synced</dt>
                <dd className="mt-0.5 text-gray-700">{new Date(record.syncedAt).toLocaleString()}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}
