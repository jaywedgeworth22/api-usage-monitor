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
  const accountId = config?.accountId as string | undefined;

  if (!accountId) {
    const profileRes = await fetchJson("https://api.tradier.com/v1/user/profile", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (!profileRes.ok) {
      return errorResult(profileRes.status, { profile: profileRes.data });
    }

    const profile = profileRes.data as {
      profile?: { account?: { account_number?: string } | Array<{ account_number?: string }> };
    };

    const account = profile.profile?.account;
    const firstAccount = Array.isArray(account) ? account[0] : account;
    const resolvedAccountId = firstAccount?.account_number;

    if (!resolvedAccountId) {
      return emptyResult({
        profile: profileRes.data,
        error: "accountId is required in config when profile has no account",
      });
    }

    return fetchAccountBalance(apiKey, resolvedAccountId, profileRes.data);
  }

  return fetchAccountBalance(apiKey, accountId);
}

async function fetchAccountBalance(
  apiKey: string,
  accountId: string,
  profile?: unknown
): Promise<UsageResult> {
  const res = await fetchJson(
    `https://api.tradier.com/v1/accounts/${accountId}/balances`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    }
  );

  if (!res.ok) {
    return errorResult(res.status, { profile, balances: res.data });
  }

  const data = res.data as {
    balances?: {
      total_equity?: number;
      total_cash?: number;
      open_pl?: number;
      margin?: { stock_buying_power?: number };
      cash?: { cash_available?: number };
    };
  };

  const balances = data.balances;
  const balance =
    parseNumber(balances?.total_equity) ?? parseNumber(balances?.total_cash);

  return {
    balance,
    totalCost: parseNumber(balances?.open_pl),
    totalRequests: null,
    credits:
      parseNumber(balances?.margin?.stock_buying_power) ??
      parseNumber(balances?.cash?.cash_available),
    rawData: { profile, balances: data },
  };
}
