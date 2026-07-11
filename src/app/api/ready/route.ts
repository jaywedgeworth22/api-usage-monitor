import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getBackupRuntimeStatus,
  getRuntimeIdentity,
  getSchedulerRuntimeStatus,
  getStartupRuntimeStatus,
} from "@/lib/runtime-health";

export const dynamic = "force-dynamic";

const DATABASE_TIMEOUT_MS = 2_000;

async function checkDatabase(): Promise<{
  ok: boolean;
  latencyMs: number;
}> {
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      prisma.$queryRawUnsafe<Array<Record<string, number>>>("SELECT 1"),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("database readiness check timed out")),
          DATABASE_TIMEOUT_MS
        );
        timeout.unref?.();
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function GET() {
  const [database, scheduler, backup, startup] = await Promise.all([
    checkDatabase(),
    Promise.resolve(getSchedulerRuntimeStatus()),
    Promise.resolve(getBackupRuntimeStatus()),
    Promise.resolve(getStartupRuntimeStatus()),
  ]);
  const schedulerReady = scheduler.startedAt !== null;
  const backupReady = !backup.required || backup.active;
  const startupReady = !startup.required || startup.active;
  const ok = database.ok && schedulerReady && backupReady && startupReady;

  return NextResponse.json(
    {
      ok,
      status: ok ? "ready" : "not_ready",
      ...getRuntimeIdentity(),
      checkedAt: new Date().toISOString(),
      checks: {
        database,
        scheduler: {
          ok: schedulerReady,
          ...scheduler,
        },
        backup: {
          ok: backupReady,
          ...backup,
        },
        startup: {
          ok: startupReady,
          ...startup,
        },
      },
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    }
  );
}
