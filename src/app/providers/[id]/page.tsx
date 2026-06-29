"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import UsageChart from "@/components/UsageChart";
import BalanceBadge from "@/components/BalanceBadge";

interface Provider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  isActive: boolean;
}

interface Snapshot {
  id: string;
  fetchedAt: string;
  balance: number | null;
  totalCost: number | null;
  totalRequests: number | null;
  credits: number | null;
}

export default function ProviderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const [providerRes, snapshotsRes] = await Promise.all([
        fetch(`/api/providers/${id}`),
        fetch(`/api/snapshots?providerId=${id}&days=30`),
      ]);

      if (!providerRes.ok) throw new Error("Provider not found");
      const providerData = await providerRes.json();
      setProvider(providerData);

      const snapshotsData = await snapshotsRes.json();
      setSnapshots(snapshotsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const hasCredits = snapshots.some((s) => s.credits != null);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !provider) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-red-600">{error || "Not found"}</p>
        <Link
          href="/"
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Back to Dashboard
        </Link>
      </div>
    );
  }

  const latest = snapshots[snapshots.length - 1];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link href="/" className="hover:text-gray-900">
          Dashboard
        </Link>
        <span>/</span>
        <span className="text-gray-900">{provider.displayName}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">
          {provider.displayName}
        </h1>
        <span className="px-2 py-1 text-xs font-medium text-gray-500 uppercase bg-gray-100 rounded">
          {provider.type}
        </span>
      </div>

      {/* Summary stats */}
      <div className={`grid ${hasCredits ? "grid-cols-4" : "grid-cols-3"} gap-4`}>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Balance</p>
          <BalanceBadge
            amount={latest?.balance ?? null}
            className="text-lg font-semibold"
          />
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Total Cost (30d)</p>
          <p className="text-lg font-semibold text-amber-600">
            {latest?.totalCost != null
              ? new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                }).format(latest.totalCost)
              : "--"}
          </p>
        </div>
        {hasCredits && (
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-xs text-gray-500 mb-1">Credits</p>
            <p className="text-lg font-semibold text-purple-600">
              {latest?.credits != null
                ? new Intl.NumberFormat("en-US").format(latest.credits)
                : "--"}
            </p>
          </div>
        )}
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <p className="text-xs text-gray-500 mb-1">Total Requests (30d)</p>
          <p className="text-lg font-semibold text-gray-900">
            {latest?.totalRequests != null
              ? new Intl.NumberFormat("en-US").format(latest.totalRequests)
              : "--"}
          </p>
        </div>
      </div>

      {/* Chart */}
      <UsageChart snapshots={snapshots} />

      {/* Snapshots Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">
            Recent Snapshots
          </h3>
        </div>
        {snapshots.length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-gray-400">
            No snapshots recorded yet
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-6 py-3 font-medium text-gray-500">
                    Date
                  </th>
                  <th className="text-right px-6 py-3 font-medium text-gray-500">
                    Balance
                  </th>
                  <th className="text-right px-6 py-3 font-medium text-gray-500">
                    Cost
                  </th>
                  {hasCredits && (
                    <th className="text-right px-6 py-3 font-medium text-gray-500">
                      Credits
                    </th>
                  )}
                  <th className="text-right px-6 py-3 font-medium text-gray-500">
                    Requests
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...snapshots].reverse().map((s) => (
                  <tr
                    key={s.id}
                    className="border-b border-gray-50 hover:bg-gray-50"
                  >
                    <td className="px-6 py-3 text-gray-600">
                      {new Date(s.fetchedAt).toLocaleString()}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <BalanceBadge amount={s.balance} />
                    </td>
                    <td className="px-6 py-3 text-right text-amber-600">
                      {s.totalCost != null
                        ? new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency: "USD",
                          }).format(s.totalCost)
                        : "--"}
                    </td>
                    {hasCredits && (
                      <td className="px-6 py-3 text-right text-purple-600">
                        {s.credits != null
                          ? new Intl.NumberFormat("en-US").format(s.credits)
                          : "--"}
                      </td>
                    )}
                    <td className="px-6 py-3 text-right text-gray-600">
                      {s.totalRequests != null
                        ? new Intl.NumberFormat("en-US").format(s.totalRequests)
                        : "--"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
