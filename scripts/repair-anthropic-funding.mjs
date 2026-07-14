#!/usr/bin/env node
/**
 * Standalone one-time repair script to unflag mustKeepFunded on the Anthropic
 * provider plan. Run manually by the operator to clean up noisy balance
 * visibility alerts on existing installations.
 */
import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL ?? "";
const sqlitePath = databaseUrl.match(/^file:(.+)$/)?.[1];
if (sqlitePath && !existsSync(sqlitePath)) {
  console.log("Anthropic funding repair: database does not exist yet.");
  process.exit(0);
}

const prisma = new PrismaClient();

async function run() {
  console.log("Checking Anthropic funding policy...");
  // Match case-insensitively since provider names match case-insensitively in JS
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true },
  });
  
  const anthropic = providers.find((p) => p.name.toLowerCase() === "anthropic");
  if (!anthropic) {
    console.log("Anthropic provider not found.");
    return;
  }

  const plan = await prisma.providerPlan.findUnique({
    where: { providerId: anthropic.id },
  });

  if (plan?.mustKeepFunded) {
    await prisma.providerPlan.update({
      where: { providerId: anthropic.id },
      data: { mustKeepFunded: false },
    });
    console.log("Successfully set mustKeepFunded to false for Anthropic.");
  } else {
    console.log("Anthropic funding policy is already correct (mustKeepFunded = false) or plan is missing.");
  }
}

run()
  .catch((e) => {
    console.error("Failed to run Anthropic funding repair:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
