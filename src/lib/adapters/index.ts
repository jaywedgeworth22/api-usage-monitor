import { decrypt } from "@/lib/crypto";
import type { Provider } from "@prisma/client";
import type { UsageResult } from "./openai";

type AdapterFn = (
  apiKey: string,
  config?: Record<string, unknown>
) => Promise<UsageResult>;

const adapters: Record<string, AdapterFn> = {};

async function loadAdapters() {
  if (Object.keys(adapters).length > 0) return;

  const modules = await Promise.all([
    import("./openai"),
    import("./anthropic"),
    import("./google-ai"),
    import("./pinecone"),
    import("./cloudflare"),
    import("./custom"),
    import("./deepseek"),
    import("./xai"),
    import("./mistral"),
    import("./llamaindex"),
    import("./fmp"),
    import("./finnhub"),
    import("./alphavantage"),
    import("./tradier"),
    import("./marketstack"),
    import("./intrinio"),
    import("./tiingo"),
    import("./twelvedata"),
    import("./fintech_studios"),
    import("./massive"),
    import("./fred"),
    import("./voyage"),
    import("./sentry"),
    import("./langfuse"),
    import("./twilio"),
    import("./resend"),
    import("./pushover"),
    import("./apify"),
    import("./stripe"),
    import("./robinhood"),
    import("./alpaca"),
  ]);

  const [
    openai, anthropic, googleAi, pinecone, cloudflare, custom,
    deepseek, xai, mistral, llamaindex,
    fmp, finnhub, alphavantage, tradier, marketstack, intrinio, tiingo, twelvedata, fintech_studios, massive, fred,
    voyage,
    sentry, langfuse,
    twilio, resend, pushover,
    apify,
    stripe,
    robinhood, alpaca,
  ] = modules;

  // LLM/AI
  adapters["openai"] = openai.fetchUsage;
  adapters["anthropic"] = anthropic.fetchUsage;
  adapters["google-ai"] = googleAi.fetchUsage;
  adapters["google_ai"] = googleAi.fetchUsage;
  adapters["googleai"] = googleAi.fetchUsage;
  adapters["google"] = googleAi.fetchUsage;
  adapters["deepseek"] = deepseek.fetchUsage;
  adapters["xai"] = xai.fetchUsage;
  adapters["mistral"] = mistral.fetchUsage;
  adapters["llamaindex"] = llamaindex.fetchUsage;

  // Vector DB
  adapters["pinecone"] = pinecone.fetchUsage;
  adapters["voyage"] = voyage.fetchUsage;

  // Market Data
  adapters["fmp"] = fmp.fetchUsage;
  adapters["finnhub"] = finnhub.fetchUsage;
  adapters["alphavantage"] = alphavantage.fetchUsage;
  adapters["tradier"] = tradier.fetchUsage;
  adapters["marketstack"] = marketstack.fetchUsage;
  adapters["intrinio"] = intrinio.fetchUsage;
  adapters["tiingo"] = tiingo.fetchUsage;
  adapters["twelvedata"] = twelvedata.fetchUsage;
  adapters["fintech-studios"] = fintech_studios.fetchUsage;
  adapters["massive"] = massive.fetchUsage;
  adapters["fred"] = fred.fetchUsage;

  // Observability
  adapters["sentry"] = sentry.fetchUsage;
  adapters["langfuse"] = langfuse.fetchUsage;

  // Notifications
  adapters["twilio"] = twilio.fetchUsage;
  adapters["resend"] = resend.fetchUsage;
  adapters["pushover"] = pushover.fetchUsage;

  // Infrastructure
  adapters["cloudflare"] = cloudflare.fetchUsage;

  // Data
  adapters["apify"] = apify.fetchUsage;

  // Payments
  adapters["stripe"] = stripe.fetchUsage;

  // Brokerage
  adapters["robinhood"] = robinhood.fetchUsage;
  adapters["alpaca"] = alpaca.fetchUsage;

  // Custom
  adapters["custom"] = custom.fetchUsage;
}

export async function fetchProviderUsage(
  provider: Provider
): Promise<UsageResult> {
  await loadAdapters();

  const adapter = adapters[provider.name.toLowerCase()] ?? adapters["custom"];
  if (!adapter) {
    throw new Error(`No adapter found for provider: ${provider.name}`);
  }

  const apiKey = provider.apiKey ? decrypt(provider.apiKey) : "";
  const config = (provider.config as Record<string, unknown> | null) ?? {};

  return adapter(apiKey, config);
}

export { loadAdapters };
