import { emptyResult, type UsageResult } from "./helpers";

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  return emptyResult({
    error: "Robinhood does not offer a public retail API for account balance",
    keyProvided: Boolean(apiKey),
    note: "Use a custom provider if you have access to an unofficial or partner API endpoint.",
  });
}
