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
  const accountSid = config?.accountId as string | undefined;

  if (!accountSid) {
    return emptyResult({
      error: "accountId (Account SID) is required in config",
    });
  }

  const auth = Buffer.from(`${accountSid}:${apiKey}`).toString("base64");
  const res = await fetchJson(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Balance.json`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  if (!res.ok) {
    return errorResult(res.status, { response: res.data });
  }

  const data = res.data as { balance?: string; currency?: string };
  const balance = parseNumber(data.balance);

  return {
    balance,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData: data,
  };
}
