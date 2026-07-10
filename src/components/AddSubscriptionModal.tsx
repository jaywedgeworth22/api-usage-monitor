/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useState } from "react";

export interface SubscriptionProviderOption {
  id: string;
  name: string;
  displayName: string;
}

export interface SubscriptionProjectOption {
  id: string;
  name: string;
}

export interface SubscriptionFormValue {
  id?: string;
  providerId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  anchorDay: number | null;
  startDate: string;
  autoRenew: boolean;
  status: string;
  notes: string | null;
}

interface AddSubscriptionModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (subscription: SubscriptionFormValue) => Promise<void>;
  editSubscription?: SubscriptionFormValue | null;
  providers: SubscriptionProviderOption[];
  projects: SubscriptionProjectOption[];
}

const INTERVALS = ["weekly", "monthly", "quarterly", "annual"];
const STATUSES = ["active", "paused", "canceled", "considering"];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function AddSubscriptionModal({
  open,
  onClose,
  onSave,
  editSubscription,
  providers,
  projects,
}: AddSubscriptionModalProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [providerId, setProviderId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [costUsd, setCostUsd] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [interval, setInterval] = useState("monthly");
  const [intervalCount, setIntervalCount] = useState("1");
  const [anchorDay, setAnchorDay] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [autoRenew, setAutoRenew] = useState(true);
  const [status, setStatus] = useState("active");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setProviderId(editSubscription?.providerId || providers[0]?.id || "");
    setProjectId(editSubscription?.projectId || "");
    setName(editSubscription?.name || "");
    setCostUsd(editSubscription?.costUsd != null ? String(editSubscription.costUsd) : "");
    setCurrency(editSubscription?.currency || "USD");
    setInterval(editSubscription?.interval || "monthly");
    setIntervalCount(editSubscription?.intervalCount ? String(editSubscription.intervalCount) : "1");
    setAnchorDay(editSubscription?.anchorDay != null ? String(editSubscription.anchorDay) : "");
    setStartDate(editSubscription?.startDate ? editSubscription.startDate.slice(0, 10) : todayIso());
    setAutoRenew(editSubscription?.autoRenew ?? true);
    setStatus(editSubscription?.status || "active");
    setNotes(editSubscription?.notes || "");
  }, [editSubscription, open, providers]);

  if (!open) return null;

  const handleSave = async () => {
    setError("");
    setSaving(true);
    try {
      if (!providerId) throw new Error("A provider is required");
      if (!name.trim()) throw new Error("A subscription name is required");
      const cost = Number(costUsd);
      if (!Number.isFinite(cost) || cost < 0) throw new Error("Cost must be a non-negative number");
      const count = Number(intervalCount);
      if (!Number.isInteger(count) || count < 1) throw new Error("Every N must be a positive integer");
      const anchor = anchorDay ? Number(anchorDay) : null;
      if (anchor != null && (!Number.isInteger(anchor) || anchor < 1 || anchor > 31)) {
        throw new Error("Renewal day must be between 1 and 31");
      }

      await onSave({
        id: editSubscription?.id,
        providerId,
        projectId: projectId || null,
        name: name.trim(),
        description: null,
        costUsd: cost,
        currency: currency.trim().toUpperCase() || "USD",
        interval,
        intervalCount: count,
        anchorDay: anchor,
        startDate,
        autoRenew,
        status,
        notes: notes.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
  const labelClass = "block text-sm font-medium text-gray-700 mb-1";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900">
              {editSubscription ? "Edit Subscription" : "Add Subscription"}
            </h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">
              &times;
            </button>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 text-red-700 text-sm rounded-lg">{error}</div>
          )}

          <div className="space-y-4">
            <div>
              <label className={labelClass}>Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Claude Max plan"
                className={inputClass}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Provider</label>
                <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className={inputClass}>
                  {providers.length === 0 && <option value="">No providers</option>}
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Project (optional)</label>
                <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputClass}>
                  <option value="">Unattributed</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Cost per period</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={costUsd}
                  onChange={(e) => setCostUsd(e.target.value)}
                  placeholder="e.g., 20"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Currency</label>
                <input
                  type="text"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  maxLength={8}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>Every N</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={intervalCount}
                  onChange={(e) => setIntervalCount(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Interval</label>
                <select value={interval} onChange={(e) => setInterval(e.target.value)} className={inputClass}>
                  {INTERVALS.map((i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Renewal day</label>
                <input
                  type="number"
                  min="1"
                  max="31"
                  step="1"
                  value={anchorDay}
                  onChange={(e) => setAnchorDay(e.target.value)}
                  placeholder="auto"
                  className={inputClass}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Start date</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className={inputClass}
                />
              </div>
              {editSubscription && (
                <div>
                  <label className={labelClass}>Status</label>
                  <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={autoRenew}
                onChange={(e) => setAutoRenew(e.target.checked)}
                className="rounded border-gray-300"
              />
              Auto-renews
            </label>

            <div>
              <label className={labelClass}>Notes (optional)</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-3 pt-6 border-t border-gray-100">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || providers.length === 0}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Subscription"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
