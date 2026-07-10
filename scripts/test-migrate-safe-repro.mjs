#!/usr/bin/env node
/**
 * Manual repro/integration test for scripts/migrate-safe.mjs.
 *
 * Exercises the real script (unmodified, invoked the same way
 * start-with-litestream.sh does) against real SQLite DB files, covering the
 * three cases that matter for the "--dry-run isn't a valid flag" bug fixed
 * here:
 *
 *   1. Additive-only diff: an old-shape DB (schema.prisma from an earlier
 *      git revision) pushed against the current schema.prisma — must exit 0
 *      and apply the new tables/columns.
 *   2. Already-in-sync: re-running against the now-current DB — must exit 0
 *      as a no-op.
 *   3. Destructive diff with real data: a DB with actual rows in a
 *      table/column that a schema change would drop — must exit non-zero,
 *      leave the DB file byte-for-byte unchanged, and print manual
 *      --accept-data-loss instructions.
 *
 * Scenario 3 needs a schema that's destructive *relative to the current
 * schema.prisma*, and migrate-safe.mjs always reads the default
 * prisma/schema.prisma path (it takes no --schema flag, matching how it's
 * actually invoked at deploy time) — so this script temporarily overwrites
 * the real prisma/schema.prisma and restores it from a backup in a
 * try/finally. It refuses to run at all if that file has uncommitted
 * changes, so it can never clobber in-progress work.
 *
 * All DB files live under a temp dir, cleaned up on exit.
 *
 * Usage: node scripts/test-migrate-safe-repro.mjs [old-schema-git-rev]
 */

import { execFileSync } from "child_process";
import {
  mkdtempSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import { createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma/schema.prisma");
const MIGRATE_SAFE = path.join(REPO_ROOT, "scripts/migrate-safe.mjs");

// An earlier commit whose prisma/schema.prisma predates the Project /
// Subscription / ProviderProjectAllocation models — gives a genuinely
// additive diff against the current schema. Override via argv[2].
const OLD_SCHEMA_REV = process.argv[2] || "421a05c";

let failures = 0;

function log(msg) {
  console.log(`[test-migrate-safe] ${msg}`);
}

function fail(msg) {
  console.error(`[test-migrate-safe] FAIL: ${msg}`);
  failures++;
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function gitShow(rev, relPath) {
  return execFileSync("git", ["show", `${rev}:${relPath}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function runMigrateSafe(dbFile) {
  try {
    const stdout = execFileSync("node", [MIGRATE_SAFE], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, stdout };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

// Pushes a given schema file directly (bypassing migrate-safe.mjs) — used
// only to construct fixture DBs in known shapes, not to exercise the fix.
function pushSchemaDirect(schemaPath, dbFile) {
  execFileSync(
    "npx",
    ["prisma", "db", "push", `--schema=${schemaPath}`, "--skip-generate", "--accept-data-loss"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
      stdio: "pipe",
    }
  );
}

// Textually strips the ProviderProjectAllocation model (a table) and
// Provider.label (a column) from a schema.prisma source, producing a
// schema that's destructive relative to any DB built from the unmodified
// current schema.
function toDestructiveSchema(source) {
  let out = source;
  // Drop Provider.label — the first `label String?` field is Provider's
  // (other models have their own unrelated `label` columns, left alone).
  out = out.replace(/^\s*label\s+String\?\s*\n/, "");
  // Drop every relation field pointing at ProviderProjectAllocation (both
  // Provider.allocations and Project.allocations reference it)...
  out = out.replace(/^\s*allocations\s+ProviderProjectAllocation\[\]\s*\n/gm, "");
  // ...and the model itself.
  out = out.replace(/\nmodel ProviderProjectAllocation \{[\s\S]*?\n\}\n/, "\n");
  if (out.includes("ProviderProjectAllocation") || out === source) {
    throw new Error(
      "toDestructiveSchema: expected patterns not found — schema.prisma shape changed, update this repro script"
    );
  }
  return out;
}

async function main() {
  const dirty = execFileSync("git", ["status", "--porcelain", "--", "prisma/schema.prisma"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (dirty) {
    console.error(
      "[test-migrate-safe] refusing to run: prisma/schema.prisma has uncommitted changes " +
        "(this script temporarily overwrites it). Commit or stash first."
    );
    process.exit(1);
  }

  const work = mkdtempSync(path.join(tmpdir(), "migrate-safe-repro-"));
  log(`working dir: ${work}`);
  const schemaBackup = path.join(work, "schema.prisma.orig-backup");
  copyFileSync(SCHEMA_PATH, schemaBackup);

  try {
    // --- Scenario 1: additive-only diff ---
    log(`Scenario 1: additive-only diff (schema.prisma@${OLD_SCHEMA_REV} -> current)`);
    const oldSchemaPath = path.join(work, "old-schema.prisma");
    writeFileSync(oldSchemaPath, gitShow(OLD_SCHEMA_REV, "prisma/schema.prisma"));
    const additiveDb = path.join(work, "additive.db");
    pushSchemaDirect(oldSchemaPath, additiveDb);

    const scenario1 = runMigrateSafe(additiveDb);
    if (scenario1.code === 0) {
      log("  PASS — additive diff applied, exit 0");
    } else {
      fail(`additive scenario exited ${scenario1.code}\n${scenario1.stdout}\n${scenario1.stderr}`);
    }

    // --- Scenario 2: already in sync (no-op) ---
    log("Scenario 2: already-in-sync re-run");
    const scenario2 = runMigrateSafe(additiveDb);
    if (scenario2.code === 0) {
      log("  PASS — no-op re-run, exit 0");
    } else {
      fail(`already-in-sync scenario exited ${scenario2.code}\n${scenario2.stdout}\n${scenario2.stderr}`);
    }

    // --- Scenario 3: destructive diff with real data ---
    log("Scenario 3: destructive diff with real data present");
    const destructiveDb = path.join(work, "destructive.db");
    copyFileSync(additiveDb, destructiveDb);

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(destructiveDb);
    db.exec(
      "INSERT INTO Provider (id, name, displayName, type, label, createdAt) " +
        "VALUES ('repro-p1','repro-provider','Repro Provider','builtin','some-label', datetime('now'))"
    );
    db.exec(
      "INSERT INTO Project (id, name, createdAt, updatedAt) " +
        "VALUES ('repro-proj1','Repro Project', datetime('now'), datetime('now'))"
    );
    db.exec(
      "INSERT INTO ProviderProjectAllocation (id, providerId, projectId, percentage, createdAt, updatedAt) " +
        "VALUES ('repro-a1','repro-p1','repro-proj1',100, datetime('now'), datetime('now'))"
    );
    db.close();

    const destructiveSchema = toDestructiveSchema(readFileSync(SCHEMA_PATH, "utf8"));
    writeFileSync(SCHEMA_PATH, destructiveSchema);

    const beforeHash = hashFile(destructiveDb);
    const scenario3 = runMigrateSafe(destructiveDb);
    const afterHash = hashFile(destructiveDb);

    // Restore the real schema immediately, before any further assertions.
    copyFileSync(schemaBackup, SCHEMA_PATH);

    if (scenario3.code !== 0 && beforeHash === afterHash) {
      log(`  PASS — destructive diff refused (exit ${scenario3.code}), DB left unchanged`);
      // migrate-safe.mjs routes all of its error-path output (including
      // Prisma's own captured stdout/stderr) through console.error, so it
      // all lands on the child process's stderr.
      if (!scenario3.stderr.includes("--accept-data-loss")) {
        fail("destructive scenario refused correctly but did not mention --accept-data-loss guidance");
      }
    } else {
      fail(
        `destructive scenario should have refused with the DB untouched; got exit=${scenario3.code}, ` +
          `dbChanged=${beforeHash !== afterHash}\n${scenario3.stdout}\n${scenario3.stderr}`
      );
    }
  } finally {
    // Always restore the real schema.prisma, even if an assertion above threw.
    copyFileSync(schemaBackup, SCHEMA_PATH);
    rmSync(work, { recursive: true, force: true });
  }

  const dirtyAfter = execFileSync("git", ["status", "--porcelain", "--", "prisma/schema.prisma"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  if (dirtyAfter) {
    fail("prisma/schema.prisma was not restored cleanly after the run");
  }

  if (failures > 0) {
    console.error(`\n[test-migrate-safe] ${failures} scenario(s) FAILED`);
    process.exit(1);
  }
  console.log("\n[test-migrate-safe] all scenarios PASSED");
}

main();
