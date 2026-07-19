"use client";

import { ChevronDown, Inbox, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  OperationsHealthSummary,
  OperationalState,
  ReceiptInboxSummary,
  SocraticInfrastructureSummary,
} from "@/lib/operations-health";

const REFRESH_INTERVAL_MS = 60_000;

export function markOperationsStale(previous: OperationsHealthSummary): OperationsHealthSummary {
  return {
    ...previous,
    receiptInbox: {
      ...previous.receiptInbox,
      state: previous.receiptInbox.configured ? "stale" : previous.receiptInbox.state,
      error: "dashboard_refresh_failed",
    },
    socraticInfrastructure: {
      ...previous.socraticInfrastructure,
      state: "stale",
      error: "dashboard_refresh_failed",
    },
  };
}

function stateLabel(state: OperationalState): string {
  return {
    healthy: "Healthy",
    degraded: "Degraded",
    receiving: "Receiving",
    stale: "Stale",
    unavailable: "Unavailable",
    unreachable: "Unreachable",
    unconfigured: "Not configured",
  }[state];
}

function stateClasses(state: OperationalState): string {
  if (state === "healthy" || state === "receiving") {
    return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
  }
  if (state === "degraded" || state === "stale") {
    return "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  }
  return "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300";
}

function formatBytes(value: number | null): string {
  if (value === null) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}

function relativeTime(value: string | null): string {
  if (!value) return "never";
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86_400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86_400)}d ago`;
}

function StatePill({ state }: { state: OperationalState }) {
  return <span className={`rounded-full px-2 py-1 text-xs font-medium ${stateClasses(state)}`}>{stateLabel(state)}</span>;
}

function DisclosureButton({ expanded, onClick, controls, children }: {
  expanded: boolean;
  onClick: () => void;
  controls: string;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-expanded={expanded} aria-controls={controls} onClick={onClick}
      className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-medium text-blue-600 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300 dark:hover:bg-blue-950/30">
      {children}
      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
    </button>
  );
}

export function ReceiptInboxCard({ data }: { data: ReceiptInboxSummary }) {
  const [expanded, setExpanded] = useState(false);
  const count = `${data.countIsLowerBound ? "at least " : ""}${data.needsReviewCount}`;
  return (
    <section aria-labelledby="receipt-inbox-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-lg bg-blue-50 p-2 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300" aria-hidden="true"><Inbox className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h3 id="receipt-inbox-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Receipt inbox</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {data.configured ? <>{count} need review · last receipt <time suppressHydrationWarning dateTime={data.latestReceivedAt ?? undefined}>{relativeTime(data.latestReceivedAt)}</time></> : "Forwarded receipts are not connected yet"}
            </p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Evidence only; review is required before any cost is recorded.</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatePill state={data.state} />
          {data.configured && data.items.length > 0 && (
            <DisclosureButton expanded={expanded} onClick={() => setExpanded((value) => !value)} controls="receipt-inbox-detail">Recent</DisclosureButton>
          )}
        </div>
      </div>
      {expanded && (
        <div id="receipt-inbox-detail" className="border-t border-gray-100 px-5 py-3 dark:border-gray-700">
          <ul className="divide-y divide-gray-100 dark:divide-gray-700">
            {data.items.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-4 py-2 text-xs">
                <div className="min-w-0">
                  <p className="truncate font-medium text-gray-800 dark:text-gray-200">{item.senderDomain}</p>
                  <p className="text-gray-500 dark:text-gray-400">{item.supportedAttachmentCount} supported of {item.attachmentCount} attachment{item.attachmentCount === 1 ? "" : "s"}</p>
                </div>
                <time suppressHydrationWarning dateTime={item.receivedAt} title={item.receivedAt} className="shrink-0 text-gray-500 dark:text-gray-400">{relativeTime(item.receivedAt)}</time>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function SocraticInfrastructureCard({ data }: { data: SocraticInfrastructureSummary }) {
  const [expanded, setExpanded] = useState(false);
  const scheduler = data.schedulerAgeSeconds === null ? "scheduler unavailable" : `scheduler ${Math.round(data.schedulerAgeSeconds)}s ago`;
  return (
    <section aria-labelledby="socratic-infrastructure-heading" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-lg bg-violet-50 p-2 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300" aria-hidden="true"><Server className="h-4 w-4" /></span>
          <div className="min-w-0">
            <h3 id="socratic-infrastructure-heading" className="text-sm font-semibold text-gray-900 dark:text-gray-100">Socratic Trade infrastructure</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Database {data.database} · {scheduler} · {data.failedDependencies.length} dependency issue{data.failedDependencies.length === 1 ? "" : "s"}</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Last checked <time suppressHydrationWarning dateTime={data.fetchedAt} title={data.fetchedAt}>{relativeTime(data.fetchedAt)}</time>{data.releaseSha ? ` · ${data.releaseSha.slice(0, 8)}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatePill state={data.state} />
          <DisclosureButton expanded={expanded} onClick={() => setExpanded((value) => !value)} controls="socratic-infrastructure-detail">Details</DisclosureButton>
        </div>
      </div>
      {expanded && (
        <div id="socratic-infrastructure-detail" className="grid gap-3 border-t border-gray-100 px-5 py-4 text-xs sm:grid-cols-2 dark:border-gray-700">
          <div>
            <p className="font-medium text-gray-800 dark:text-gray-200">Storage &amp; backup</p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">DB {formatBytes(data.dbSizeBytes)} · WAL {formatBytes(data.walSizeBytes)}</p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">Free {formatBytes(data.freeBytes)} · Litestream {data.litestreamState ?? "Unavailable"}</p>
          </div>
          <div>
            <p className="font-medium text-gray-800 dark:text-gray-200">Runtime &amp; dependencies</p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">{data.activeTradingAccounts ?? "Unavailable"} active account{data.activeTradingAccounts === 1 ? "" : "s"} · {data.degradedTradingAccounts ?? "Unavailable"} degraded</p>
            <p className="mt-1 text-gray-500 dark:text-gray-400">{data.failedDependencies.length > 0 ? data.failedDependencies.join(", ") : "No dependency failures reported"}</p>
            <a href={data.adminUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex min-h-11 items-center font-medium text-blue-600 hover:underline dark:text-blue-300">Open full Socratic admin panel</a>
          </div>
        </div>
      )}
    </section>
  );
}

export default function OperationsOverview() {
  const [data, setData] = useState<OperationsHealthSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const refresh = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await fetch("/api/operations", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData((await response.json()) as OperationsHealthSummary);
      setRequestError(null);
    } catch {
      setRequestError("Operations status could not be refreshed.");
      setData((previous) => previous ? markOperationsStale(previous) : null);
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return (
    <section aria-labelledby="operations-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 id="operations-heading" className="text-sm font-semibold text-gray-800 dark:text-gray-200">Operations</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Receipt intake and service health, kept separate from provider costs.</p>
        </div>
        <button type="button" onClick={() => void refresh(true)} disabled={refreshing}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" /> Refresh
        </button>
      </div>
      <div aria-live="polite" className="sr-only">{requestError ?? (data ? "Operations status refreshed." : "Loading operations status.")}</div>
      {requestError && <p className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{requestError}{data ? " Last confirmed data is marked stale." : ""}</p>}
      {data ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <ReceiptInboxCard data={data.receiptInbox} />
          <SocraticInfrastructureCard data={data.socraticInfrastructure} />
        </div>
      ) : !requestError ? (
        <div className="grid gap-3 lg:grid-cols-2" aria-hidden="true">
          <div className="h-28 animate-pulse rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800" />
          <div className="h-28 animate-pulse rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800" />
        </div>
      ) : null}
    </section>
  );
}
