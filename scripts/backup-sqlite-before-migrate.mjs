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
      log(`creating consistent snapshot of ${databasePath}`);
      await backup(source, partialPath);
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
