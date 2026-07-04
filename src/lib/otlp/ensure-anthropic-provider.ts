import { prisma } from "@/lib/prisma";

// Lazily seeds a "anthropic" Provider row the first time Claude Code OTLP
// usage lands, so the owner has somewhere in Settings to attach a
// monthlyBudgetUsd (budget-status.ts's spend computation already reads
// ExternalUsageEvent regardless of whether a Provider row exists — see
// src/lib/budget-status.ts's `pushedMap` — but the /api/budget-status
// "unconfigured" vs "ok/warning/exceeded" status and the Settings UI's
// budget form both need a Provider row to attach the budget to).
//
// This mirrors the task's instruction to "seed anthropic / claude-code with
// no budget so the owner can set one in the UI" but does it lazily on first
// ingest rather than via a one-off migration script, because:
//   - This app has no existing seed-script convention (providers are only
//     ever created via POST /api/providers, driven by the Settings UI).
//   - A user may already have an "anthropic" Provider row from the existing
//     poll adapter (src/lib/adapters/anthropic.ts, keyed on orgId) - budget-
//     status.ts matches provider names case-insensitively, so creating a
//     SECOND "anthropic" row would double it up in the provider list. This
//     check-then-create is idempotent against that: it only creates a row
//     when no case-insensitive match exists yet, and never mutates an
//     existing row's config/plan.
//
// Runs at most once in the metrics ingest route's hot path (a cheap
// findFirst before any events are known to map to a new provider), and is a
// no-op after the first successful creation.
export async function ensureAnthropicProviderSeeded(): Promise<void> {
  // Prisma's `mode: "insensitive"` filter is Postgres/MySQL-only and throws
  // on this app's SQLite datasource, so match case-insensitively in JS —
  // same approach budget-status.ts already uses for provider-name matching.
  const providers = await prisma.provider.findMany({ select: { id: true, name: true } });
  const existing = providers.some((p) => p.name.toLowerCase() === "anthropic");
  if (existing) return;

  await prisma.provider.create({
    data: {
      name: "anthropic",
      displayName: "Anthropic (Claude Code)",
      type: "push",
      isActive: true,
      // No apiKey/config: this provider is fed entirely by pushed OTLP
      // telemetry, never polled.
      refreshIntervalMin: 60,
      // No plan row: monthlyBudgetUsd stays unset until the owner configures
      // one in Settings, per the task's "no budget so the owner can set one"
      // instruction.
    },
  });
}
