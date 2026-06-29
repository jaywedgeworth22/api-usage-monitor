"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import ProviderCard from "@/components/ProviderCard";

interface Provider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  isActive: boolean;
  latestSnapshot: {
    balance: number | null;
    totalCost: number | null;
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
}

export default function DashboardPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchProviders = useCallback(async () => {
    try {
      setLoading(true);
      setError("");
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error("Failed to fetch providers");
      const data = await res.json();
      setProviders(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  const totalBalance = providers.reduce(
    (sum, p) => sum + (p.latestSnapshot?.balance || 0),
    0
  );
  const totalCost = providers.reduce(
    (sum, p) => sum + (p.latestSnapshot?.totalCost || 0),
    0
  );
  const totalCredits = providers.reduce(
    (sum, p) => sum + (p.latestSnapshot?.credits || 0),
    0
  );
  const hasAnyCredits = providers.some(
    (p) => p.latestSnapshot?.credits != null
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <p className="text-red-600">{error}</p>
        <button
          onClick={fetchProviders}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <p className="text-sm text-gray-500 mb-1">Total Balance</p>
          <p className="text-3xl font-bold text-gray-900">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(totalBalance)}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <p className="text-sm text-gray-500 mb-1">Total Cost This Month</p>
          <p className="text-3xl font-bold text-amber-600">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(totalCost)}
          </p>
        </div>
        {hasAnyCredits && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <p className="text-sm text-gray-500 mb-1">Total Credits</p>
            <p className="text-3xl font-bold text-purple-600">
              {new Intl.NumberFormat("en-US").format(totalCredits)}
            </p>
          </div>
        )}
      </div>

      {/* Provider Grid */}
      {providers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4">
          <svg
            className="w-16 h-16 text-gray-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
            />
          </svg>
          <p className="text-gray-500 text-lg">No providers configured yet</p>
          <Link
            href="/settings"
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Add your first provider
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              id={provider.id}
              name={provider.name}
              displayName={provider.displayName}
              type={provider.type}
              latestSnapshot={provider.latestSnapshot}
            />
          ))}
        </div>
      )}
    </div>
  );
}
