"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface Snapshot {
  id: string;
  fetchedAt: string;
  balance: number | null;
  totalCost: number | null;
  totalRequests: number | null;
  credits: number | null;
}

interface UsageChartProps {
  snapshots: Snapshot[];
}

export default function UsageChart({ snapshots }: UsageChartProps) {
  if (snapshots.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 bg-gray-50 rounded-xl border border-dashed border-gray-300">
        <p className="text-gray-400 text-sm">No usage data yet</p>
      </div>
    );
  }

  const hasCredits = snapshots.some((s) => s.credits != null);

  const data = snapshots.map((s) => ({
    date: new Date(s.fetchedAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    balance: s.balance ?? undefined,
    cost: s.totalCost ?? undefined,
    credits: s.credits ?? undefined,
  }));

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-4">
        Usage Over Time
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
          <defs>
            <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="colorCredits" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#a855f7" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 12, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
          />
          <YAxis
            tick={{ fontSize: 12, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
            tickFormatter={(v: number) => `$${v}`}
          />
          <Tooltip
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid #e5e7eb",
              boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
            }}
            formatter={(value: number, name: string) => {
              if (name === "balance") return [`$${value.toFixed(2)}`, "Balance"];
              if (name === "cost") return [`$${value.toFixed(2)}`, "Cost"];
              if (name === "credits") return [value.toLocaleString(), "Credits"];
              return [value, name];
            }}
          />
          <Area
            type="monotone"
            dataKey="balance"
            stroke="#3b82f6"
            strokeWidth={2}
            fill="url(#colorBalance)"
            name="Balance"
          />
          <Area
            type="monotone"
            dataKey="cost"
            stroke="#f59e0b"
            strokeWidth={2}
            fill="url(#colorCost)"
            name="Cost"
          />
          {hasCredits && (
            <Area
              type="monotone"
              dataKey="credits"
              stroke="#a855f7"
              strokeWidth={2}
              fill="url(#colorCredits)"
              name="Credits"
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
