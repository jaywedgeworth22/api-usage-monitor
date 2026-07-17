// External telemetry intentionally keeps the producer's provider string as
// received (it is part of the shared idempotency contract and useful for
// diagnostics). Read-time joins use this conservative alias table so legacy
// producer names still land on the correct configured Provider row.

function identityToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function identitySlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");

  let start = 0;
  let end = slug.length;
  while (start < end && slug.charCodeAt(start) === 45) start += 1;
  while (end > start && slug.charCodeAt(end - 1) === 45) end -= 1;
  return slug.slice(start, end);
}

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  alphavantage: "alphavantage",
  anthropic: "anthropic",
  claude: "anthropic",
  claudeai: "anthropic",
  deepseek: "deepseek",
  financialmodelingprep: "fmp",
  financialmodelingpreparation: "fmp",
  fintechstudios: "fintech-studios",
  fmp: "fmp",
  gemini: "google-ai",
  geminiapi: "google-ai",
  generativelanguage: "google-ai",
  google: "google-ai",
  googleai: "google-ai",
  googleaistudio: "google-ai",
  googlegemini: "google-ai",
  grok: "xai",
  hetznercloud: "hetzner",
  llamacloud: "llamaindex",
  llamaindex: "llamaindex",
  llamaindexcloud: "llamaindex",
  llamaparse: "llamaindex",
  massive: "massive",
  massivecom: "massive",
  polygon: "massive",
  polygonio: "massive",
  openrouter: "openrouter",
  openrouterai: "openrouter",
  pinecone: "pinecone",
  pineconedb: "pinecone",
  quiver: "quiver-quant",
  quiverquant: "quiver-quant",
  quiverquantitative: "quiver-quant",
  rendercom: "render",
  twelvedata: "twelvedata",
  unusualwhales: "unusual-whales",
  uw: "unusual-whales",
  voyage: "voyage",
  voyageai: "voyage",
  xai: "xai",
};

/** Case-insensitive exact-name key. Exact configured names outrank aliases. */
export function normalizedProviderName(provider: string): string {
  return provider.trim().toLowerCase();
}

/** Stable comparison key for provider joins. Never persist this over raw input. */
export function canonicalProviderKey(provider: string): string {
  const token = identityToken(provider);
  return PROVIDER_ALIASES[token] ?? identitySlug(provider);
}

export interface ProviderIdentityCandidate {
  id: string;
  name: string;
  identityPriority?: number;
}

/**
 * Resolve a producer provider label to one configured row. An exact configured
 * name wins (so a deliberate custom `gemini` connection is not stolen by the
 * built-in Google alias); alias fallback then prefers the canonical slug and a
 * stable id tie-break.
 */
export function resolveProviderIdentity<T extends ProviderIdentityCandidate>(
  provider: string,
  candidates: readonly T[]
): T | null {
  const exactName = normalizedProviderName(provider);
  const exact = candidates
    .filter((candidate) => normalizedProviderName(candidate.name) === exactName)
    .sort(
      (left, right) =>
        (right.identityPriority ?? 0) - (left.identityPriority ?? 0) ||
        left.id.localeCompare(right.id)
    );
  if (exact.length > 0) return exact[0];

  const canonical = canonicalProviderKey(provider);
  const aliases = candidates
    .filter((candidate) => canonicalProviderKey(candidate.name) === canonical)
    .sort((left, right) => {
      const leftCanonical = normalizedProviderName(left.name) === canonical ? 0 : 1;
      const rightCanonical = normalizedProviderName(right.name) === canonical ? 0 : 1;
      return leftCanonical - rightCanonical ||
        (right.identityPriority ?? 0) - (left.identityPriority ?? 0) ||
        left.id.localeCompare(right.id);
    });
  return aliases[0] ?? null;
}

const PROJECT_ALIASES: Readonly<Record<string, string>> = {
  congresstrade: "congress-trade",
  congresstradecom: "congress-trade",
  socratictrade: "socratic-trade",
  socratictradecom: "socratic-trade",
};

/**
 * Comparison key for the legacy sourceApp -> Project.name fallback. Explicit
 * projectId attribution remains authoritative; this only recovers known old
 * names such as `socratic-trade` vs `SocraticTrade.com`.
 */
export function canonicalProjectKey(project: string): string {
  const token = identityToken(project);
  return PROJECT_ALIASES[token] ?? identitySlug(project);
}
