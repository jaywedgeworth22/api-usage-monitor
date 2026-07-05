import { resilientFetch, type UsageResult } from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const rawData: Record<string, unknown> = {};
  let totalCost: number | null = null;
  let totalRequests: number | null = null;

  // Anthropic's billing/usage API is behind the Console and not fully public.
  // Try the organizations usage endpoint and the rate-limit headers as fallback.

  // 1. Try the organizations usage endpoint if orgId is provided
  const orgId = config?.orgId as string | undefined;
  if (orgId) {
    try {
      const usageRes = await resilientFetch(
        `https://api.anthropic.com/v1/organizations/${orgId}/usage`,
        {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
        }
      );
      if (usageRes.ok) {
        const data = await usageRes.json();
        rawData.usage = data;
        if (typeof data.total_cost === "number") totalCost = data.total_cost;
        if (typeof data.total_requests === "number") totalRequests = data.total_requests;
      } else {
        rawData.usageStatus = `HTTP ${usageRes.status}`;
      }
    } catch (err) {
      rawData.usageError = err instanceof Error ? err.message : "Failed";
    }
  }

  // 2. Probe rate-limit headers from a lightweight Messages API call
  try {
    const probeRes = await resilientFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-3-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    // We deliberately throw away the response; we just want the headers
    const remaining = probeRes.headers.get("anthropic-ratelimit-requests-remaining");
    const limit = probeRes.headers.get("anthropic-ratelimit-requests-limit");
    const reset = probeRes.headers.get("anthropic-ratelimit-requests-reset");
    rawData.rateLimit = {
      remaining: remaining ? parseInt(remaining) : null,
      limit: limit ? parseInt(limit) : null,
      reset: reset || null,
      probeStatus: probeRes.status,
    };
  } catch (err) {
    rawData.rateLimitError = err instanceof Error ? err.message : "Failed";
  }

  if (Object.keys(rawData).length === 0) {
    rawData.note = "No orgId configured. Add orgId in provider config to enable usage tracking. Anthropic does not expose a public billing REST API.";
  }

  return { balance: null, totalCost, totalRequests, credits: null, rawData };
}
