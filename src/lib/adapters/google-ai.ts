import { fetchJson } from "./helpers";
import type { UsageResult } from "./openai";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const rawData: Record<string, unknown> = {};
  let totalRequests: number | null = null;

  // Google AI Studio does not expose a public billing/usage REST API.
  // Usage is visible only at https://aistudio.google.com/app/apikey.
  // As a workaround, we probe the rate-limit headers from a lightweight call.

  try {
    const probeRes = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { headers: { "Content-Type": "application/json" } }
    );

    if (probeRes.ok) {
      const data = probeRes.data as { models?: unknown[] };
      rawData.availableModels = Array.isArray(data.models)
        ? data.models.length
        : null;

      // Google returns rate-limit headers (RPQ = requests per quota, usually per minute)
      const remaining = probeRes.headers.get("x-ratelimit-remaining");
      const limit = probeRes.headers.get("x-ratelimit-limit");
      const reset = probeRes.headers.get("x-ratelimit-reset");
      if (remaining || limit) {
        rawData.rateLimit = {
          remaining: remaining ? parseInt(remaining) : null,
          limit: limit ? parseInt(limit) : null,
          reset: reset || null,
        };
      }

      // Count models as a proxy for available services
      totalRequests = Array.isArray(data.models) ? data.models.length : null;
    } else {
      rawData.probeStatus = `HTTP ${probeRes.status}`;
    }
  } catch (err) {
    rawData.probeError = err instanceof Error ? err.message : "Failed";
  }

  rawData.note = "Google AI Studio does not expose a public billing/usage REST API. Usage is visible at https://aistudio.google.com/app/apikey. To track actual spend, configure Google Cloud Billing API instead.";

  return { balance: null, totalCost: null, totalRequests, credits: null, rawData };
}
