#!/usr/bin/env node
/**
 * Safe migration script for Prisma + SQLite deployments.
 *
 * This script replaces `npx prisma db push --accept-data-loss` with a
 * safer two-step process:
 *
 *   1. Run `prisma db push --dry-run` to inspect the diff.
 *   2. Parse the output to determine if the changes are safe (additive only)
 *      or destructive (removing tables/columns).
 *   3. If safe: run `prisma db push` (without --accept-data-loss).
 *   4. If destructive: exit with error and instructions for manual migration.
 *
 * This prevents the silent data loss that --accept-data-loss can cause,
 * especially on SQLite where Prisma must often recreate entire tables to
 * apply schema changes.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";

const DB_PATH = process.env.DATABASE_URL;

function log(message) {
  console.log(`[migrate-safe] ${message}`);
}

function error(message) {
  console.error(`[migrate-safe] ERROR: ${message}`);
}

function run(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: "pipe" });
}

async function main() {
  // If the database file doesn't exist yet (first deploy), `prisma db push`
  // is always safe — it will create all tables from scratch.
  let dbExists = false;
  if (DB_PATH) {
    // Parse the SQLite file path from DATABASE_URL (format: "file:/path/to/db")
    const match = DB_PATH.match(/^file:(.+)$/);
    if (match) {
      dbExists = existsSync(match[1]);
    }
  }

  if (!dbExists) {
    log("No existing database found — creating schema from scratch (safe).");
    run("npx prisma db push");
    log("Database created successfully.");
    return;
  }

  log("Existing database found — checking for safe schema changes...");

  // Run a dry-run to see what changes Prisma would make.
  let dryRunOutput;
  try {
    dryRunOutput = run("npx prisma db push --dry-run");
  } catch (err) {
    error(`prisma db push --dry-run failed: ${err.message}`);
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
    process.exit(1);
  }

  // If the dry-run reports no changes, we're good.
  if (
    dryRunOutput.includes("No schema change") ||
    dryRunOutput.includes("is already in sync") ||
    dryRunOutput.includes("Nothing to push")
  ) {
    log("Schema is already in sync — no migration needed.");
    return;
  }

  log("Schema changes detected. Analyzing diff for safety...");

  // Parse the dry-run output for destructive operations.
  // Prisma's dry-run output includes lines like:
  //   - [*] Changed the `foo` table
  //   - [+] Added the `bar` table
  //   - [-] Removed the `baz` table
  //   - [*] Altered the `foo` table  (for column changes)
  //
  // On SQLite, Prisma often recreates tables instead of using ALTER TABLE,
  // which shows up as "Changed" or "Altered" — these are potentially
  // destructive because they involve dropping and recreating tables.
  const lines = dryRunOutput.split("\n");

  const destructivePatterns = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect table removals
    if (trimmed.includes("[-]") || trimmed.includes("Removed")) {
      destructivePatterns.push(`Table removal: ${trimmed}`);
    }

    // Detect column changes (especially risky on SQLite)
    // On SQLite, Prisma's output for column changes is particularly
    // dangerous because it recreates the entire table.
    if (
      (trimmed.includes("[*]") || trimmed.includes("Changed") || trimmed.includes("Altered")) &&
      !trimmed.includes("No schema change")
    ) {
      destructivePatterns.push(`Potentially destructive change: ${trimmed}`);
    }
  }

  if (destructivePatterns.length > 0) {
    error("DESTRUCTIVE SCHEMA CHANGES DETECTED:");
    for (const pattern of destructivePatterns) {
      console.error(`  • ${pattern}`);
    }
    console.error("");
    console.error(
      "These changes may cause data loss on SQLite (table recreation, column drops, etc.)."
    );
    console.error("");
    console.error("To proceed safely:");
    console.error(
      "  1. Back up the production database: Render Shell → cp /data/prod.db /data/prod.db.backup"
    );
    console.error(
      "  2. Review the full diff with: npx prisma db push --dry-run (from the Render Shell)"
    );
    console.error(
      "  3. If you're certain the changes are safe (e.g., only adding new optional columns"
    );
    console.error(
      "     or new tables), manually run: npx prisma db push --accept-data-loss"
    );
    console.error(
      "  4. Or use Prisma Migrate for a proper migration: npx prisma migrate dev"
    );
    process.exit(1);
  }

  // Only additive changes detected (new tables, new columns that don't
  // require table recreation). Run prisma db push without --accept-data-loss.
  // Note: prisma db push without --accept-data-loss will still refuse to run
  // if it detects any risk, so this is a double safety check.
  log("Detected additive-only changes — applying safely...");
  try {
    run("npx prisma db push");
    log("Schema migrated successfully.");
  } catch (err) {
    error(`prisma db push failed: ${err.message}`);
    if (err.stdout) console.error(err.stdout);
    if (err.stderr) console.error(err.stderr);
    console.error("");
    console.error(
      "prisma db push refused to apply the changes even though our dry-run"
    );
    console.error(
      "analysis suggested they were safe. This can happen when Prisma's own"
    );
    console.error(
      "safety checks disagree with our analysis. Review the output above and"
    );
    console.error(
      "consider running manually with --accept-data-loss if you're certain."
    );
    process.exit(1);
  }
}

main();
