import { prisma } from "@/lib/prisma";

export async function ensureAgentSyncProviderSeeded(): Promise<void> {
  const providers = await prisma.provider.findMany({ select: { name: true } });
  const existing = providers.some((p) => p.name.toLowerCase() === "agent-sync-relay");
  if (existing) return;

  await prisma.provider.create({
    data: {
      name: "agent-sync-relay",
      displayName: "Agent Sync Relay",
      type: "builtin",
      isActive: true,
      refreshIntervalMin: 15, // Check every 15 minutes
    },
  });
}
