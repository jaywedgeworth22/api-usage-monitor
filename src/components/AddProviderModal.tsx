"use client";

import { useState } from "react";

interface Provider {
  id?: string;
  name: string;
  displayName: string;
  type: string;
  config?: Record<string, unknown>;
  apiKey?: string;
  label?: string | null;
  keyPreview?: string | null;
}

interface AddProviderModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (provider: Provider) => Promise<void>;
  editProvider?: Provider | null;
  existingProviders?: Provider[];
}

interface ProviderDef {
  name: string;
  displayName: string;
  type: string;
  category: string;
  needsAccountId?: boolean;
  needsOrgId?: boolean;
  needsOrgSlug?: boolean;
  creditBased?: boolean;
  helpNote?: string;
  needsConfig?: { fields: { key: string; label: string; placeholder: string }[] };
}

const BUILT_IN_PROVIDERS: ProviderDef[] = [
  // LLM/AI
  { name: "openai", displayName: "OpenAI", type: "builtin", category: "LLM/AI" },
  { name: "anthropic", displayName: "Anthropic", type: "builtin", category: "LLM/AI", needsOrgId: true, helpNote: "Add your Organization ID to enable usage tracking. Find it in console.anthropic.com > Settings > Organization." },
  { name: "google-ai", displayName: "Google AI", type: "builtin", category: "LLM/AI", helpNote: "Google AI Studio has no public usage API. Usage is visible at aistudio.google.com/app/apikey. Configure Google Cloud Billing for spend tracking." },
  { name: "deepseek", displayName: "DeepSeek", type: "builtin", category: "LLM/AI", helpNote: "No public usage API. Check dashboard at platform.deepseek.com." },
  { name: "xai", displayName: "xAI (Grok)", type: "builtin", category: "LLM/AI", helpNote: "No public usage API. Check dashboard at console.x.ai." },
  { name: "mistral", displayName: "Mistral AI", type: "builtin", category: "LLM/AI", helpNote: "No public usage API. Check dashboard at console.mistral.ai." },

  // Vector DB & Embeddings
  { name: "pinecone", displayName: "Pinecone", type: "builtin", category: "Vector DB", helpNote: "Fetches index stats (record count, dimension). No billing API." },
  { name: "voyage", displayName: "Voyage AI", type: "builtin", category: "Vector DB", creditBased: true, helpNote: "Credit-based embedding service. Check dashboard at voyageai.com." },

  // Market Data
  { name: "fmp", displayName: "FMP", type: "builtin", category: "Market Data", helpNote: "No public usage API. Track calls via dashboard. Rate limits in response headers." },
  { name: "finnhub", displayName: "Finnhub", type: "builtin", category: "Market Data", helpNote: "No public usage API. Free: 60 calls/min. Check finnhub.io." },
  { name: "alphavantage", displayName: "Alpha Vantage", type: "builtin", category: "Market Data", helpNote: "No public usage API. Free: 25 calls/day. Check dashboard." },
  { name: "tradier", displayName: "Tradier", type: "builtin", category: "Market Data", helpNote: "No public usage API. Tiered plans. Check dashboard.tradier.com." },
  { name: "marketstack", displayName: "Marketstack", type: "builtin", category: "Market Data", helpNote: "No public usage API. Check marketstack.com dashboard." },
  { name: "intrinio", displayName: "Intrinio", type: "builtin", category: "Market Data", helpNote: "No public usage API. Paid tiers. Check intrinio.com." },
  { name: "tiingo", displayName: "Tiingo", type: "builtin", category: "Market Data", helpNote: "No public usage API. Freemium. Check tiingo.com." },
  { name: "twelvedata", displayName: "Twelve Data", type: "builtin", category: "Market Data", helpNote: "No public usage API. Free: 800 calls/day. Check dashboard." },
  { name: "fintech-studios", displayName: "Fintech Studios", type: "builtin", category: "Market Data", helpNote: "No public usage API. Paid service." },
  { name: "massive", displayName: "Massive", type: "builtin", category: "Market Data", helpNote: "No public usage API. Paid unlimited plan available." },
  { name: "fred", displayName: "FRED", type: "builtin", category: "Market Data", helpNote: "Free federal data. No usage limits or billing." },

  // Observability
  { name: "sentry", displayName: "Sentry", type: "builtin", category: "Observability", needsOrgSlug: true, helpNote: "Enter your Sentry org slug to fetch error/transaction quotas." },
  { name: "langfuse", displayName: "Langfuse", type: "builtin", category: "Observability", creditBased: true, helpNote: "LLM observability. Usage visible at cloud.langfuse.com." },

  // Notifications
  { name: "twilio", displayName: "Twilio", type: "builtin", category: "Notifications", needsAccountId: true, helpNote: "Enter your Account SID to track message/minute usage." },
  { name: "resend", displayName: "Resend", type: "builtin", category: "Notifications", helpNote: "Email provider. Free: 100/day. Check resend.com dashboard." },
  { name: "pushover", displayName: "Pushover", type: "builtin", category: "Notifications", helpNote: "Push notification service. Tracks monthly message allowance." },

  // Infrastructure
  { name: "cloudflare", displayName: "Cloudflare", type: "builtin", category: "Infrastructure", needsAccountId: true, helpNote: "Requires Account ID + Email. Tracks Workers, D1, R2, KV, Queue analytics." },

  // Data
  { name: "apify", displayName: "Apify", type: "builtin", category: "Data", creditBased: true, helpNote: "Credit-based web scraping. Check console.apify.com for usage." },
  { name: "llamaindex", displayName: "LlamaIndex Cloud", type: "builtin", category: "Data", creditBased: true, helpNote: "Credit-based OCR/parsing (free: 10k credits/mo). Check cloud.llamaindex.ai." },

  // Payments
  { name: "stripe", displayName: "Stripe", type: "builtin", category: "Payments", helpNote: "Tracks account balance and MRR. Uses Stripe Balance API." },

  // Brokerage
  { name: "robinhood", displayName: "Robinhood", type: "builtin", category: "Brokerage", helpNote: "Portfolio tracking. Best-effort via MCP. No public usage API." },
  { name: "alpaca", displayName: "Alpaca", type: "builtin", category: "Brokerage", helpNote: "Tracks portfolio value and day trade count via account endpoint." },
];

const CATEGORIES = [
  "LLM/AI",
  "Vector DB",
  "Market Data",
  "Observability",
  "Notifications",
  "Infrastructure",
  "Data",
  "Payments",
  "Brokerage",
];

type Tab = "builtin" | "custom";

export default function AddProviderModal({
  open,
  onClose,
  onSave,
  editProvider,
  existingProviders = [],
}: AddProviderModalProps) {
  const [tab, setTab] = useState<Tab>(editProvider?.type === "custom" ? "custom" : "builtin");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [selectedBuiltin, setSelectedBuiltin] = useState(editProvider?.name || "");
  const [apiKey, setApiKey] = useState(editProvider?.apiKey || "");
  const [label, setLabel] = useState(editProvider?.label || "");
  const [extraFields, setExtraFields] = useState<Record<string, string>>(
    (editProvider?.config as Record<string, string>) || {}
  );

  const selectedDef = BUILT_IN_PROVIDERS.find((p) => p.name === selectedBuiltin);

  const matchingExisting = existingProviders.filter(
    (p) => p.name === selectedBuiltin
  );

  // Custom fields
  const [customName, setCustomName] = useState(
    tab === "custom" ? editProvider?.name || "" : ""
  );
  const [customDisplayName, setCustomDisplayName] = useState(
    tab === "custom" ? editProvider?.displayName || "" : ""
  );
  const [customEndpoint, setCustomEndpoint] = useState(
    (editProvider?.config as Record<string, string>)?.endpoint || ""
  );
  const [customAuthType, setCustomAuthType] = useState(
    (editProvider?.config as Record<string, string>)?.authType || "bearer"
  );
  const [customAuthHeader, setCustomAuthHeader] = useState(
    (editProvider?.config as Record<string, string>)?.authHeaderName || "Authorization"
  );
  const [customBalancePath, setCustomBalancePath] = useState(
    (editProvider?.config as Record<string, string>)?.balancePath || "$.balance"
  );
  const [customCostPath, setCustomCostPath] = useState(
    (editProvider?.config as Record<string, string>)?.costPath || "$.cost"
  );
  const [customRequestsPath, setCustomRequestsPath] = useState(
    (editProvider?.config as Record<string, string>)?.requestsPath || "$.requests"
  );
  const [trackCredits, setTrackCredits] = useState(
    !!(editProvider?.config as Record<string, string>)?.creditsPath
  );
  const [customCreditsPath, setCustomCreditsPath] = useState(
    (editProvider?.config as Record<string, string>)?.creditsPath || "$.credits"
  );

  if (!open) return null;

  const handleSave = async () => {
    setError("");
    setSaving(true);

    try {
      if (tab === "builtin") {
        if (!selectedDef) {
          setError("Please select a provider");
          setSaving(false);
          return;
        }

        const config: Record<string, string> = { ...extraFields };
        // Build extra config based on provider needs
        if (selectedDef.needsAccountId) {
          if (!config.accountId) {
            config.accountId = extraFields.accountId || "";
          }
        }

        await onSave({
          id: editProvider?.id,
          name: selectedDef.name,
          displayName: selectedDef.displayName,
          type: "builtin",
          apiKey: apiKey || undefined,
          config: Object.keys(config).length > 0 ? config : undefined,
          label: label || undefined,
        });
      } else {
        if (!customName || !customDisplayName || !customEndpoint) {
          setError("Name, display name, and endpoint are required");
          setSaving(false);
          return;
        }

        const config: Record<string, string> = {
          endpoint: customEndpoint,
          authType: customAuthType,
          authHeaderName: customAuthHeader,
          balancePath: customBalancePath,
          costPath: customCostPath,
          requestsPath: customRequestsPath,
        };
        if (trackCredits) {
          config.creditsPath = customCreditsPath;
        }

        await onSave({
          id: editProvider?.id,
          name: customName.toLowerCase().replace(/\s+/g, "-"),
          displayName: customDisplayName,
          type: "custom",
          apiKey: apiKey || undefined,
          config,
          label: label || undefined,
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const renderExtraFields = () => {
    if (!selectedDef) return null;

    const fields: { key: string; label: string; placeholder: string; type?: string }[] = [];

    if (selectedDef.needsAccountId) {
      if (selectedDef.name === "cloudflare") {
        fields.push({ key: "accountId", label: "Account ID", placeholder: "Cloudflare Account ID" });
        fields.push({ key: "accountEmail", label: "Account Email", placeholder: "Cloudflare Account Email", type: "email" });
        fields.push({ key: "databaseId", label: "D1 Database ID (optional)", placeholder: "D1 database UUID" });
        fields.push({ key: "r2BucketName", label: "R2 Bucket Name (optional)", placeholder: "R2 bucket name" });
        fields.push({ key: "kvNamespaceId", label: "KV Namespace ID (optional)", placeholder: "KV namespace UUID" });
        fields.push({ key: "queueId", label: "Queue ID (optional)", placeholder: "Queue UUID" });
      } else if (selectedDef.name === "twilio") {
        fields.push({ key: "accountId", label: "Account SID", placeholder: "Twilio Account SID" });
      }
    }

    if (selectedDef.needsOrgSlug) {
      fields.push({ key: "orgSlug", label: "Organization Slug", placeholder: "Sentry org slug" });
    }

    if (selectedDef.needsOrgId) {
      fields.push({ key: "orgId", label: "Organization ID", placeholder: "Anthropic Organization ID" });
    }

    const hasHelp = !!selectedDef.helpNote;

    return fields.length > 0 || hasHelp ? (
      <div className="space-y-3">
        {fields.length > 0 && (
          <>
            <p className="text-xs font-medium text-gray-500">Extra Configuration</p>
            {fields.map((f) => (
              <div key={f.key}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {f.label}
                </label>
                <input
                  type={f.type || "text"}
                  value={extraFields[f.key] || ""}
                  onChange={(e) =>
                    setExtraFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            ))}
          </>
        )}
        {hasHelp && (
          <div className="rounded-lg bg-blue-50 border border-blue-100 p-3">
            <p className="text-xs text-blue-800 leading-relaxed">{selectedDef.helpNote}</p>
          </div>
        )}
      </div>
    ) : null;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative bg-white rounded-2xl shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900">
              {editProvider ? "Edit Provider" : "Add Provider"}
            </h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              &times;
            </button>
          </div>

          <div className="flex border-b border-gray-200 mb-6">
            <button
              onClick={() => setTab("builtin")}
              className={`flex-1 pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === "builtin"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Built-in
            </button>
            <button
              onClick={() => setTab("custom")}
              className={`flex-1 pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === "custom"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              Custom
            </button>
          </div>

          {tab === "builtin" ? (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Provider
                </label>
                <select
                  value={selectedBuiltin}
                  onChange={(e) => {
                    setSelectedBuiltin(e.target.value);
                    const def = BUILT_IN_PROVIDERS.find((p) => p.name === e.target.value);
                    setExtraFields({});
                    if (def?.creditBased && editProvider) {
                      // keep existing config
                      setExtraFields((editProvider?.config as Record<string, string>) || {});
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Select a provider...</option>
                  {CATEGORIES.map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {BUILT_IN_PROVIDERS.filter((p) => p.category === cat).map(
                        (p) => (
                          <option key={p.name} value={p.name}>
                            {p.displayName}
                            {p.creditBased ? " (credits)" : ""}
                          </option>
                        )
                      )}
                    </optgroup>
                  ))}
                </select>
                {selectedDef?.creditBased && (
                  <p className="text-xs text-purple-600 mt-1">
                    Credit-based provider — credits tracking enabled
                  </p>
                )}
              </div>

              {matchingExisting.length > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                  <p className="text-xs font-medium text-blue-700 mb-2">
                    You already have {matchingExisting.length}{" "}
                    {matchingExisting.length === 1 ? "provider" : "providers"} configured
                    for {selectedDef?.displayName ?? selectedBuiltin}:
                  </p>
                  <ul className="space-y-1">
                    {matchingExisting.map((p) => (
                      <li key={p.id} className="text-xs text-blue-600 flex items-center gap-2">
                        <code className="bg-blue-100 px-1.5 py-0.5 rounded text-[11px]">
                          {p.keyPreview ?? "(no key preview)"}
                        </code>
                        {p.label && (
                          <span className="text-blue-500">({p.label})</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  API Key
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={editProvider ? "Leave blank to keep current" : "Your API key"}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                {editProvider && !apiKey && editProvider.keyPreview && (
                  <p className="text-xs text-gray-500 mt-1">
                    Current key:{" "}
                    <code className="bg-gray-100 px-1.5 py-0.5 rounded text-[11px]">
                      {editProvider.keyPreview}
                    </code>
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Label (optional)
                </label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Agentic Trading, Congress.Trade"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-400 mt-0.5">Tag this key to distinguish it from others with the same provider name</p>
              </div>

              {renderExtraFields()}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name (slug)
                  </label>
                  <input
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="my-api"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={customDisplayName}
                    onChange={(e) => setCustomDisplayName(e.target.value)}
                    placeholder="My API"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  API Key
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={editProvider ? "Leave blank to keep current" : "Your API key"}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                {editProvider && !apiKey && editProvider.keyPreview && (
                  <p className="text-xs text-gray-500 mt-1">
                    Current key:{" "}
                    <code className="bg-gray-100 px-1.5 py-0.5 rounded text-[11px]">
                      {editProvider.keyPreview}
                    </code>
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Label (optional)
                </label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Production, Staging"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <p className="text-xs text-gray-400 mt-0.5">Tag this key to distinguish it from others</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Endpoint URL
                </label>
                <input
                  type="text"
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder="https://api.example.com/usage"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Auth Type
                </label>
                <select
                  value={customAuthType}
                  onChange={(e) => setCustomAuthType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="bearer">Bearer Token</option>
                  <option value="api-key">API Key</option>
                  <option value="basic">Basic Auth</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Auth Header Name
                </label>
                <input
                  type="text"
                  value={customAuthHeader}
                  onChange={(e) => setCustomAuthHeader(e.target.value)}
                  placeholder="Authorization"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={trackCredits}
                  onChange={(e) => setTrackCredits(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">Track credits</span>
              </label>

              <fieldset className="border border-gray-200 rounded-lg p-3 space-y-3">
                <legend className="text-sm font-medium text-gray-700 px-1">
                  Response Mapping (JSON paths)
                </legend>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Balance path</label>
                  <input
                    type="text"
                    value={customBalancePath}
                    onChange={(e) => setCustomBalancePath(e.target.value)}
                    placeholder="$.balance"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Cost path</label>
                  <input
                    type="text"
                    value={customCostPath}
                    onChange={(e) => setCustomCostPath(e.target.value)}
                    placeholder="$.cost"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Requests path</label>
                  <input
                    type="text"
                    value={customRequestsPath}
                    onChange={(e) => setCustomRequestsPath(e.target.value)}
                    placeholder="$.requests"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                {trackCredits && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Credits path</label>
                    <input
                      type="text"
                      value={customCreditsPath}
                      onChange={(e) => setCustomCreditsPath(e.target.value)}
                      placeholder="$.credits"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                )}
              </fieldset>
            </div>
          )}

          {error && (
            <p className="mt-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="mt-6 flex gap-3 justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : editProvider ? "Update" : "Add Provider"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
