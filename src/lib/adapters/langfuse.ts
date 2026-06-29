import {
  emptyResult,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const publicKey = (config?.publicKey as string | undefined) || apiKey;
  const secretKey = config?.secretKey as string | undefined;
  const host =
    (config?.host as string | undefined) || "https://cloud.langfuse.com";

  if (!secretKey) {
    return emptyResult({
      error: "secretKey is required in config (Langfuse secret key)",
      note: "Store the public key in the API key field and the secret key in config.",
    });
  }

  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const res = await fetchJson(
    `${host.replace(/\/$/, "")}/api/public/metrics/daily?page=1&limit=31`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as {
    data?: Array<{
      countTraces?: number;
      countObservations?: number;
      totalCost?: number;
    }>;
  };

  let totalCost = 0;
  let totalRequests = 0;
  let foundCost = false;
  let foundRequests = false;

  for (const day of data.data || []) {
    if (typeof day.totalCost === "number") {
      totalCost += day.totalCost;
      foundCost = true;
    }
    if (typeof day.countObservations === "number") {
      totalRequests += day.countObservations;
      foundRequests = true;
    }
  }

  return {
    balance: null,
    totalCost: foundCost ? totalCost : null,
    totalRequests: foundRequests ? totalRequests : null,
    credits: null,
    rawData: data,
  };
}
