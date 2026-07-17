#!/usr/bin/env node
/**
 * Create and verify a transaction-consistent backup of an existing SQLite
 * database before migrate-safe.mjs changes its schema.
 *
 * Node's sqlite.backup() wraps SQLite's Online Backup API. A completed backup
 * is a consistent snapshot even when the source uses WAL or receives a write
 * while the copy is running. The source is opened read-only, the destination
 * is written under a private directory beside the database, and only a backup
 * that passes PRAGMA integrity_check is promoted from .partial to .backup.db.
 *
 * Existing databases fail closed on every backup/verification/retention error.
 * A missing database is the expected first-deploy case and needs no backup.
 *
 * References:
 * - https://www.sqlite.org/backup.html
 * - https://nodejs.org/docs/latest-v24.x/api/sqlite.html
 */

import { backup, DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RETENTION = 3;
const MAX_RETENTION = 10;
const BACKUP_DIRECTORY = ".pre-migration-backups";

function log(message) {
  console.log(`[sqlite-pre-migration-backup] ${message}`);
}

function clampedIntEnv(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

// Native (non-heap) memory bound on the read-only connections this script
// opens against the live database. Shares SQLITE_CACHE_SIZE_KIB /
// SQLITE_MMAP_SIZE_BYTES with src/lib/prisma.ts's applySqliteNativeMemoryPragmas
// (same rationale: SQLite's own page cache/mmap are native allocations
// outside any V8 heap cap) so operators tune one pair of knobs for the whole
// app instead of two. Copying and integrity-checking a 130MB+ database is the
// heaviest I/O this script does; an unbounded mmap here would let the OS map
// large chunks of that file into this short-lived process's address space
// right before migrate-safe and npm start start their own memory ramp.
function applySqliteMemoryPragmas(database) {
  const cacheSizeKib = -Math.abs(
    clampedIntEnv("SQLITE_CACHE_SIZE_KIB", 2_000, 256, 65_536)
  );
  const mmapSizeBytes = clampedIntEnv("SQLITE_MMAP_SIZE_BYTES", 0, 0, 268_435_456);
  database.exec(`PRAGMA cache_size = ${cacheSizeKib}`);
  database.exec(`PRAGMA mmap_size = ${mmapSizeBytes}`);
}

// Pages copied per sqlite3_backup_step() call. Node's own default is 100;
// exposed so a smaller value can be set if the backup's per-step native
// working set ever needs to shrink further. Node does not await the
// `progress` callback between steps (verified empirically - it fires steps
// back-to-back), so this does NOT add pacing/inter-step delays, only bounds
// how many pages move in a single native step.
const BACKUP_RATE_PAGES = clampedIntEnv("SQLITE_BACKUP_RATE_PAGES", 100, 1, 1000);

function parseDatabasePath(databaseUrl) {
  if (!databaseUrl?.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a file: SQLite URL");
  }

  const withoutQuery = databaseUrl.split(/[?#]/, 1)[0];
  if (withoutQuery === "file::memory:" || withoutQuery === "file:") {
    throw new Error("DATABASE_URL must point to a persistent SQLite file");
  }

  if (withoutQuery.startsWith("file://")) {
    return fileURLToPath(new URL(withoutQuery));
  }

  let path;
  try {
    path = decodeURIComponent(withoutQuery.slice("file:".length));
  } catch {
    throw new Error("DATABASE_URL contains invalid percent encoding");
  }
  if (!path || path === ":memory:") {
    throw new Error("DATABASE_URL must point to a persistent SQLite file");
  }
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function retentionCount(raw) {
  if (raw == null || raw.trim() === "") return DEFAULT_RETENTION;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETENTION) {
    throw new Error(
      `SQLITE_PRE_MIGRATION_BACKUP_RETENTION must be an integer from 1 to ${MAX_RETENTION}`
    );
  }
  return value;
}

function backupPrefix(databasePath) {
  return `${basename(databasePath)}.pre-migration-`;
}

function managedBackups(backupDirectory, prefix) {
  return readdirSync(backupDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(prefix) &&
        entry.name.endsWith(".backup.db")
    )
    .map((entry) => {
      const path = join(backupDirectory, entry.name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
}

function removeStalePartials(backupDirectory, prefix) {
  for (const entry of readdirSync(backupDirectory, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.startsWith(prefix) &&
      entry.name.endsWith(".partial")
    ) {
      unlinkSync(join(backupDirectory, entry.name));
    }
  }
}

function pruneToRetention(backupDirectory, prefix, retention) {
  const existing = managedBackups(backupDirectory, prefix);
  const removeCount = Math.max(0, existing.length - retention);
  for (const item of existing.slice(0, removeCount)) {
    unlinkSync(item.path);
    log(`pruned old backup ${basename(item.path)}`);
  }
}

function assertIntegrity(path) {
  const database = new DatabaseSync(path, {
    readOnly: true,
    timeout: 30_000,
  });
  try {
    applySqliteMemoryPragmas(database);
    const rows = database.prepare("PRAGMA integrity_check").all();
    if (
      rows.length !== 1 ||
      Object.values(rows[0] ?? {}).length !== 1 ||
      Object.values(rows[0])[0] !== "ok"
    ) {
      throw new Error("backup PRAGMA integrity_check did not return exactly 'ok'");
    }
  } finally {
    database.close();
  }
}

function fsyncFile(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensurePrivateBackupDirectory(path) {
  if (existsSync(path)) {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`backup path is not a real directory: ${path}`);
    }
  } else {
    mkdirSync(path, { mode: 0o700 });
  }

  // Check again after creation before chmod so an existing symlink is never
  // followed and used as the destination for a database containing secrets.
  const created = lstatSync(path);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`backup path is not a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

async function main() {
  // Backups contain every credential and usage row in the database. Ensure a
  // newly-created directory/file is private even before the explicit chmod.
  process.umask(0o077);

  const databasePath = parseDatabasePath(process.env.DATABASE_URL);
  if (!existsSync(databasePath)) {
    log(`no existing database at ${databasePath}; backup not required`);
    return;
  }
  if (!lstatSync(databasePath).isFile()) {
    throw new Error(`database path is not a regular file: ${databasePath}`);
  }

  const retention = retentionCount(
    process.env.SQLITE_PRE_MIGRATION_BACKUP_RETENTION
  );
  const backupDirectory = join(dirname(databasePath), BACKUP_DIRECTORY);
  ensurePrivateBackupDirectory(backupDirectory);

  const prefix = backupPrefix(databasePath);
  removeStalePartials(backupDirectory, prefix);
  // First repair any prior retention overflow, but preserve the full bounded
  // set while creating the replacement. If the new backup fails, the previous
  // verified backups remain available instead of being pruned preemptively.
  pruneToRetention(backupDirectory, prefix, retention);

  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const stem = `${prefix}${timestamp}-${process.pid}`;
  const partialPath = join(backupDirectory, `${stem}.partial`);
  const finalPath = join(backupDirectory, `${stem}.backup.db`);

  try {
    const source = new DatabaseSync(databasePath, {
      readOnly: true,
      timeout: 30_000,
    });
    try {
      applySqliteMemoryPragmas(source);
      log(`creating consistent snapshot of ${databasePath}`);
      await backup(source, partialPath, { rate: BACKUP_RATE_PAGES });
    } finally {
      source.close();
    }
    chmodSync(partialPath, 0o600);
    assertIntegrity(partialPath);
    fsyncFile(partialPath);
    renameSync(partialPath, finalPath);
    // The file fsync above persists its contents; fsyncing the containing
    // directory makes the atomic rename durable across a host crash.
    fsyncDirectory(backupDirectory);
    pruneToRetention(backupDirectory, prefix, retention);
    fsyncDirectory(backupDirectory);
    log(
      `verified ${basename(finalPath)} (${statSync(finalPath).size} bytes; retention ${retention})`
    );
  } catch (error) {
    rmSync(partialPath, { force: true });
    rmSync(finalPath, { force: true });
    throw error;
  }

  const retained = managedBackups(backupDirectory, prefix);
  if (retained.length > retention) {
    throw new Error(
      `backup retention invariant failed: found ${retained.length}, expected at most ${retention}`
    );
  }
}

main().catch((error) => {
  console.error(
    `[sqlite-pre-migration-backup] ERROR: ${
      error instanceof Error ? error.message : "unknown backup failure"
    }`
  );
  process.exitCode = 1;
});
