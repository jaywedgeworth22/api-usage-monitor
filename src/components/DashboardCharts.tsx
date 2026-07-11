"use client";

import React, { useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { useTheme } from "next-themes";

interface ChartProvider {
  displayName: string;
  projectedEomUsd: number;
}

interface DashboardChartsProps {
  providers: ChartProvider[];
}

export default function DashboardCharts({ providers }: DashboardChartsProps) {
  const { resolvedTheme } = useTheme();
  
  const data = useMemo(() => {
    return providers
      .filter((p) => p.projectedEomUsd > 0)
      .map((p) => ({
        name: p.displayName,
        value: p.projectedEomUsd,
      }))
      .sort((a, b) => b.value - a.value);
  }, [providers]);

  // A nice set of colors for the pie chart slices
  const COLORS = [
    "#3b82f6", // blue-500
    "#8b5cf6", // violet-500
    "#ec4899", // pink-500
    "#14b8a6", // teal-500
    "#f59e0b", // amber-500
    "#ef4444", // red-500
    "#10b981", // emerald-500
    "#6366f1", // indigo-500
  ];

  if (data.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Projected Cost Breakdown
      </h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={80}
              paddingAngle={2}
              dataKey="value"
            >
              {data.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={COLORS[index % COLORS.length]}
                  stroke={resolvedTheme === "dark" ? "#1f2937" : "#ffffff"}
                  strokeWidth={2}
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number) =>
                new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                }).format(value)
              }
              contentStyle={{
                backgroundColor: resolvedTheme === "dark" ? "#1f2937" : "#ffffff",
                borderColor: resolvedTheme === "dark" ? "#374151" : "#e5e7eb",
                color: resolvedTheme === "dark" ? "#f3f4f6" : "#111827",
                borderRadius: "0.5rem",
              }}
              itemStyle={{ color: resolvedTheme === "dark" ? "#f3f4f6" : "#111827" }}
            />
            <Legend wrapperStyle={{ fontSize: "14px" }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
