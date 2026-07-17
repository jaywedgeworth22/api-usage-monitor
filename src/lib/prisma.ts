import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  __apiUsageMonitorSqlitePragmasApplied: Promise<void> | undefined;
};

function clampedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

// --- Single-connection SQLite pool -----------------------------------------
// Prisma's SQLite "library" engine opens a POOL of connections (default
// num_cpus*2+1), and the native page-cache / mmap bounds set below are
// PER-CONNECTION - a PRAGMA issued on one pooled connection does not apply to
// the others (verified empirically: with a pool >1, concurrent `PRAGMA
// mmap_size` reads return a mix of the value we set and the default). Forcing
// `connection_limit=1` makes the bound deterministic and pool-wide, and is
// itself a native-memory reduction: one connection's cache/mmap instead of N.
// It is safe here because this is a single Render instance against a local
// SQLite file whose internal writes are already serialized (see
// ingest-admission.ts), and no $transaction callback in this codebase issues
// a query through the global client (only through its `tx` handle), so a
// single connection cannot self-deadlock. Overridable via
// SQLITE_CONNECTION_LIMIT for operators who deliberately want more.
function withConnectionLimit(url: string): string {
  if (/[?&]connection_limit=/.test(url)) return url; // respect an explicit value
  const limit = clampedIntEnv("SQLITE_CONNECTION_LIMIT", 1, 1, 64);
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=${limit}`;
}

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  // With no URL, defer to Prisma's own env-driven construction (and its own
  // clear "Environment variable not found: DATABASE_URL" error path) rather
  // than fabricating a datasource override.
  if (!url) return new PrismaClient();
  return new PrismaClient({
    datasources: { db: { url: withConnectionLimit(url) } },
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// --- Native (non-heap) SQLite memory bounds --------------------------------
// Prisma's default "library" engine for SQLite embeds its own SQLite driver
// as an in-process N-API addon (no separate query-engine process). Its page
// cache and any memory-mapped I/O are native Rust/C allocations that live
// OUTSIDE the V8 heap, so `NODE_OPTIONS=--max-old-space-size` (the heap cap
// added in #387) cannot bound them, and a heap-limit hit would produce a
// distinct "JavaScript heap out of memory" fatal error rather than a silent
// container OOM-kill. A restart cycling between ~440-496MB used and a fresh
// baseline with the heap capped at 350MB points at this native side.
//
// SQLite's compiled-in default page cache is already small (cache_size of
// -2000, ~2MB), but we pin it explicitly so behavior doesn't depend on
// whatever the bundled SQLite amalgamation happened to compile in for
// Render's Linux binary, and so it becomes a documented, tunable knob.
// mmap_size is disabled outright: memory-mapped pages of a 130MB+ database
// count toward the process's resident set the same as any other native
// allocation, and this 512MB container has no slack to let the OS map large
// chunks of the file into the query engine's address space.
//
// There is no dedicated per-connection init hook in Prisma's public API for
// SQLite, so this is applied as an explicit, idempotent, awaited step -
// see instrumentation.ts's register(), which Next.js guarantees completes
// before the server accepts any request (so no query can race ahead of it).
// It is applied against the single pooled connection above (see
// withConnectionLimit), and read back to confirm it actually took effect.
export interface SqliteMemoryPragmaValues {
  cacheSizeKib: number;
  mmapSizeBytes: number;
}

export function resolveSqliteMemoryPragmaValues(): SqliteMemoryPragmaValues {
  return {
    // Negative values are KiB per SQLite convention: -2000 = ~2MB cache.
    cacheSizeKib: -Math.abs(clampedIntEnv("SQLITE_CACHE_SIZE_KIB", 2_000, 256, 65_536)),
    // 0 disables mmap I/O entirely; a positive value is a byte ceiling.
    mmapSizeBytes: clampedIntEnv("SQLITE_MMAP_SIZE_BYTES", 0, 0, 268_435_456),
  };
}

/**
 * Reads the currently-effective cache_size / mmap_size off the live
 * connection. SQLite returns these as 64-bit INTEGERs, which Prisma surfaces
 * as JS BigInt, so each is coerced to Number before returning.
 */
export async function readSqliteMemoryPragmas(): Promise<SqliteMemoryPragmaValues> {
  const cacheRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "PRAGMA cache_size"
  );
  const mmapRows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    "PRAGMA mmap_size"
  );
  return {
    cacheSizeKib: Number(cacheRows[0]?.cache_size),
    mmapSizeBytes: Number(mmapRows[0]?.mmap_size),
  };
}

export function applySqliteNativeMemoryPragmas(): Promise<void> {
  if (!globalForPrisma.__apiUsageMonitorSqlitePragmasApplied) {
    globalForPrisma.__apiUsageMonitorSqlitePragmasApplied = (async () => {
      const target = resolveSqliteMemoryPragmaValues();
      try {
        // A PRAGMA assignment RETURNS the applied value as a result row on
        // SQLite, so it must go through the query path. `$executeRaw*` rejects
        // it with "Execute returned results, which is not allowed in SQLite" -
        // which is exactly why an earlier `$executeRawUnsafe` version silently
        // no-op'd and left SQLite's defaults (mmap_size=0, cache_size=-2000)
        // in place, masking the failure whenever those defaults happened to
        // match the target.
        await prisma.$queryRawUnsafe(`PRAGMA cache_size = ${target.cacheSizeKib}`);
        await prisma.$queryRawUnsafe(`PRAGMA mmap_size = ${target.mmapSizeBytes}`);
        // Read the values back on the same connection and confirm they took.
        // A mismatch is logged loudly (never swallowed): it would mean a future
        // engine change rejected a PRAGMA, or connection_limit was raised above
        // 1 and split the pool, either of which silently re-opens the native
        // memory regression this function exists to prevent.
        const applied = await readSqliteMemoryPragmas();
        if (
          applied.cacheSizeKib !== target.cacheSizeKib ||
          applied.mmapSizeBytes !== target.mmapSizeBytes
        ) {
          console.error(
            `[prisma] SQLite native memory bounds did not take effect ` +
              `(wanted cache_size=${target.cacheSizeKib}, mmap_size=${target.mmapSizeBytes}; ` +
              `read back cache_size=${applied.cacheSizeKib}, mmap_size=${applied.mmapSizeBytes})`
          );
        }
      } catch (error) {
        console.error(
          "[prisma] failed to apply native SQLite memory bounds; continuing with SQLite defaults",
          error
        );
      }
    })();
  }
  return globalForPrisma.__apiUsageMonitorSqlitePragmasApplied;
}

/**
 * Test-only: clears the module-level memoization so a test can call
 * applySqliteNativeMemoryPragmas again after changing env-driven tuning
 * values. Mirrors resetRuntimeHealthForTests's guard in runtime-health.ts.
 */
export function resetSqliteNativeMemoryPragmasForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      "SQLite native memory pragma state can only be reset in tests"
    );
  }
  globalForPrisma.__apiUsageMonitorSqlitePragmasApplied = undefined;
}
