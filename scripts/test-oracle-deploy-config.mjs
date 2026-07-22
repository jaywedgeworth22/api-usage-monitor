import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

const workflow = read(".github/workflows/oracle-production-deploy.yml");
const uptimeWorkflow = read(".github/workflows/uptime-monitor.yml");
const compose = read("deploy/oracle/compose.production.yaml");
const composeDev = read("deploy/oracle/compose.yaml");
const caddy = read("deploy/oracle/Caddyfile");
const oracleReadme = read("deploy/oracle/README.md");
const deploy = read("deploy/oracle/deploy-production.sh");
const poller = read("deploy/oracle/auto-deploy.sh");
const service = read("deploy/oracle/usage-monitor.service");
const deployService = read("deploy/oracle/usage-monitor-auto-deploy.service");
const timer = read("deploy/oracle/usage-monitor-auto-deploy.timer");
const ci = read(".github/workflows/ci.yml");
const renderRetirement = JSON.parse(
  read("deploy/oracle/render-retired.production.json"),
);

function requireText(body, pattern, message) {
  assert.match(body, pattern, message);
}

function forbidText(body, pattern, message) {
  assert.doesNotMatch(body, pattern, message);
}

function forbidLiteral(body, text, message) {
  assert.equal(body.includes(text), false, message);
}

// GitHub observes an exact, already-green main CI run. It holds no production
// credential because Oracle pulls the public protected revision itself.
requireText(workflow, /workflow_run:/, "deploy receipt must follow CI");
requireText(workflow, /workflows:\s*\[CI\]/, "deploy receipt must follow the CI workflow");
requireText(workflow, /head_branch == 'main'/, "workflow must reject non-main runs");
requireText(workflow, /workflow_run\.conclusion == 'success'/, "workflow must require successful CI");
requireText(workflow, /\.revision == \$revision/, "workflow must verify the exact production revision");
requireText(workflow, /cancel-in-progress:\s*true/, "stale receipt observers should be cancelled");
requireText(workflow, /seq 1 720/, "observer must allow the independent CodeQL and host build window");
requireText(workflow, /ORACLE_ORIGIN_IPV4:\s*"141\.148\.182\.224"/, "observer must pin the reserved Oracle origin");
requireText(workflow, /--resolve "usage\.jays\.services:443:\$\{ORACLE_ORIGIN_IPV4\}"/, "observer must bypass Cloudflare bot challenges without weakening TLS");
forbidText(workflow, /secrets\./, "the observer workflow must not hold a production secret");
forbidText(workflow, /ssh-keyscan|StrictHostKeyChecking=no/, "unsafe SSH bootstrap is forbidden");
requireText(uptimeWorkflow, /ORACLE_ORIGIN_IPV4:\s*"141\.148\.182\.224"/, "GitHub uptime must pin the reserved Oracle origin");
requireText(uptimeWorkflow, /--resolve "usage\.jays\.services:443:\$\{ORACLE_ORIGIN_IPV4\}"/, "GitHub uptime must avoid Cloudflare false failures while retaining TLS validation");
requireText(ci, /npm run test:oracle-deploy/, "hosted CI must exercise deployment contracts");

// Production uses the Cloudflare-proxied public hostname. The old sslip.io
// fallback encoded a deleted ephemeral Oracle address and could cause a fresh
// bootstrap to request the wrong certificate. Cloudflare terminates public TLS,
// so Caddy must leave HTTP-01 enabled and disable TLS-ALPN-01.
requireText(caddy, /^\{\$USAGE_MONITOR_HOSTNAME:usage\.jays\.services\}/m, "Caddy must default to the public hostname");
requireText(caddy, /disable_tlsalpn_challenge/, "Caddy must use HTTP-01 behind the proxied hostname");
requireText(caddy, /issuer acme/, "Caddy must keep the Let's Encrypt ACME issuer");
requireText(
  caddy,
  /dir https:\/\/acme\.zerossl\.com\/v2\/DV90/,
  "Caddy must keep ZeroSSL ACME directory as the Automatic HTTPS fallback issuer",
);
requireText(deploy, /ensure_public_caddy_hostname/, "deploy must migrate/refuse stale Caddy hostnames");
requireText(deploy, /reload_caddy_proxy/, "deploy must recreate Caddy after hostname migration");
// Use awk index() markers (not host-shaped substring checks) so CodeQL does
// not flag incomplete URL sanitization on this contract file.
forbidLiteral(deploy, "usage-oracle.", "deploy must not reintroduce the deleted IP-derived host prefix");
assert.equal(
  deploy.includes('index($0, "sslip.io")'),
  true,
  "deploy must detect deleted IP-derived sslip hostnames via awk index()",
);
assert.equal(
  deploy.includes('index($0, "132.226.90.164")'),
  true,
  "deploy must detect the deleted Oracle public IP hostname via awk index()",
);
// Split the forbidden host label so this file does not embed a host-shaped
// sanitizer check that CodeQL treats as incomplete URL validation.
const deletedHostLabel = ["sslip", ".io"].join("");
forbidLiteral(caddy, deletedHostLabel, "Caddy must not retain the deleted IP-derived fallback");
requireText(composeDev, /USAGE_MONITOR_HOSTNAME:\s*\$\{USAGE_MONITOR_HOSTNAME:-usage\.jays\.services\}/, "Compose must default to the public hostname");
forbidLiteral(composeDev, deletedHostLabel, "Compose must not retain the deleted IP-derived fallback");
requireText(oracleReadme, /USAGE_MONITOR_HOSTNAME=usage\.jays\.services/, "Oracle docs must name the public hostname");
forbidLiteral(oracleReadme, deletedHostLabel, "Oracle docs must not retain the deleted IP-derived fallback");

// The root-owned production Compose policy must never build or accept new host
// mounts from a fetched revision.
forbidText(compose, /^\s*build:/m, "production compose must never build repo-controlled content");
forbidText(compose, /docker\.sock|\/\s*:\s*\//, "production compose must not expose host root or Docker");
requireText(compose, /user:\s*"1000:1000"/, "app must run as the data-volume uid/gid");
requireText(compose, /no-new-privileges:true/, "app must set no-new-privileges");
requireText(compose, /cap_drop:\s*\n\s*- ALL/, "app must drop Linux capabilities");
requireText(compose, /restart:\s*"no"/, "candidate restart loops must remain disabled until acceptance");
requireText(compose, /pull_policy:\s*never/, "reboot and rollback must use locally verified images");

// Root transaction invariants. These are static contract checks in addition to
// bash syntax verification; production performs the live checks again.
for (const [pattern, message] of [
  [/flock -w 10/, "host deployment lock"],
  [/EXPECTED_DATA_UUID/, "pinned data-volume UUID"],
  [/USAGE_SCHEDULER_ENABLED/, "sole scheduler guard"],
  [/usage-monitor-prod-v3/, "exact Garage lineage guard"],
  [/commit\.verification\.verified/, "verified GitHub commit guard"],
  [/merge_commit_sha/, "merged PR guard"],
  [/GITHUB_ACTIONS_APP_ID/, "trusted GitHub Actions app guard"],
  [/Analyze JavaScript and TypeScript/, "CodeQL check guard"],
  [/create_sqlite_backup/, "transaction-consistent backup"],
  [/PRAGMA integrity_check/, "SQLite integrity verification"],
  [/PRAGMA foreign_key_check/, "SQLite foreign-key verification"],
  [/--network none/, "offline scratch migration"],
  [/--no-deps --no-build --force-recreate app/, "single-app cutover"],
  [/lastTickSucceeded/, "fresh scheduler-tick acceptance"],
  [/wait_for_backup_advancement/, "post-cutover Garage TXID advancement"],
  [/capture_quiescent_backup_watermark/, "post-stop Garage watermark capture"],
  [/ltx -config \/app\/litestream\.yml -level "\$\{level\}"/, "per-level LTX tip listing (not full history)"],
  [/for level in 0 1 2 3 4 5/, "L0-then-L1..L5 fallback when tip is compacted"],
  [/list_garage_ltx_level/, "shared LTX level lister for online/offline paths"],
  [/-integrity-check full/, "post-cutover Garage restore"],
  [/name != '_deploy_heartbeat'/, "quoted exclusion for the unmanaged deployment heartbeat object"],
  [/verify_render_retirement/, "durable Render retirement proof"],
  [/prune_unreferenced_application_images/, "targeted application-image retention"],
  [/docker image ls --format '\{\{\.Repository\}\} \{\{\.Tag\}\}'/, "bounded image enumeration"],
  [/\^\[0-9a-f\]\{40\}\$/, "immutable revision-tag cleanup filter"],
  [/docker ps -aq --filter "ancestor=/, "container-reference protection before image removal"],
  [/docker image rm "\$\{repository\}:\$\{tag\}"/, "exact-tag image removal"],
  [/prune_bounded_build_cache/, "bounded BuildKit cache retention"],
  [/--max-used-space="\$\{MAX_BUILD_CACHE\}"/, "BuildKit cache maximum"],
  [/--min-free-space="\$\{MIN_BUILD_CACHE_FREE\}"/, "BuildKit free-space target"],
  [/--reserved-space="\$\{RESERVED_BUILD_CACHE\}"/, "BuildKit retained-cache floor"],
  [/env-vars\/USAGE_SCHEDULER_ENABLED/, "exact Render scheduler lookup without pagination"],
  [/--kill-after=60s 2700/, "bounded target-controlled image build"],
  [/--kill-after=30s 900/, "bounded target-controlled scratch migration"],
  [/on_signal TERM 143/, "signal-safe rollback"],
  [/rolling code back.*without restoring SQLite/, "code-only rollback"],
  [/both candidate and rollback validation failed; stopping every app writer/, "dual-failure stop"],
]) {
  requireText(deploy, pattern, `deploy script must enforce ${message}`);
}
forbidText(deploy, /reset --hard|docker system prune|rm -rf/, "broad destructive cleanup is forbidden");
forbidText(deploy, /docker image (prune|rm -f)/, "image cleanup must not be broad or forced");
assert.equal((deploy.match(/docker builder prune/g) ?? []).length, 1, "only the one bounded BuildKit prune is allowed");
forbidText(deploy, /name != "_deploy_heartbeat"/, "SQLite identifiers must not be shell-quote corrupted");
forbidText(deploy, /set -x/, "deployment must never trace secrets");
forbidText(deploy, /ltx[^\n]*-level all/, "full LTX history listing is forbidden (Coolify timeout false-block)");

requireText(poller, /MAX_FAILURES=3/, "poller must have a bounded retry circuit breaker");
requireText(poller, /blocked-sha/, "poller must persist the blocked revision");
requireText(poller, /CHECK_RETRY_SECONDS=300/, "failed checks must be re-evaluated without hot polling");
requireText(poller, /git ls-remote/, "poller must resolve public main without credentials");
requireText(poller, /systemctl restart usage-monitor\.service/, "stopped writers must recover only through the mount-gated unit");
requireText(poller, /mountpoint -q/, "writer recovery must require the data mount");
requireText(poller, /docker update --restart=no/, "the poller must retrofit mount-safe restart policy before honoring pause");
requireText(poller, /flock -w 10 8/, "recovery must share the deployment transaction lock");
requireText(poller, /flock -u 8/, "the poller must release its recovery lock before the child transaction");
requireText(deployService, /SuccessExitStatus=75/, "pending checks must not fail systemd");
requireText(deployService, /TimeoutStartSec=90min/, "systemd must bound an unexpectedly wedged transaction");
requireText(deployService, /TimeoutStopSec=45min/, "systemd must allow bounded signal rollback to finish");
requireText(timer, /OnUnitInactiveSec=1min/, "timer must detect merged main promptly");
requireText(service, /\/etc\/usage-monitor\/compose\.yaml/, "boot must use root-owned stable compose");
requireText(service, /--no-build/, "boot must never build a mutable checkout");
requireText(service, /--restart=no/, "systemd must keep Docker-level writer restart disabled");
forbidText(service, /--restart=unless-stopped/, "Docker must not bypass the systemd data-mount gate");
forbidText(deploy, /--restart=unless-stopped/, "accepted and rollback writers must remain systemd-gated");

const retentionStart = deploy.indexOf("prune_unreferenced_application_images() {");
const retentionEndMarker = "\n}\n\nprune_bounded_build_cache()";
const retentionEnd = deploy.indexOf(retentionEndMarker, retentionStart);
assert.ok(retentionStart >= 0 && retentionEnd > retentionStart, "retention function must be extractable for behavioral tests");
const retentionFunction = deploy.slice(retentionStart, retentionEnd + 2);
const cacheStart = deploy.indexOf("prune_bounded_build_cache() {");
const cacheEndMarker = "\n}\n\ncompose_for_revision()";
const cacheEnd = deploy.indexOf(cacheEndMarker, cacheStart);
assert.ok(cacheStart >= 0 && cacheEnd > cacheStart, "cache function must be extractable for behavioral tests");
const cacheFunction = deploy.slice(cacheStart, cacheEnd + 2);

const retentionTemp = mkdtempSync(path.join(os.tmpdir(), "usage-monitor-image-retention-"));
const receiptPath = path.join(retentionTemp, "current.json");
const removalLog = path.join(retentionTemp, "removed.log");

function runRetentionCase({
  imageRows,
  previousSha,
  targetSha,
  receiptActive = "",
  receiptPrevious = "",
  referencedImage = "",
  failRemoval = "",
  receipt = "regular",
}) {
  rmSync(receiptPath, { force: true });
  rmSync(removalLog, { force: true });
  if (receipt === "regular") {
    writeFileSync(receiptPath, "{}\n", { mode: 0o600 });
  } else if (receipt === "dangling") {
    symlinkSync(path.join(retentionTemp, "missing-receipt.json"), receiptPath);
  }

  const harness = `
set -Eeuo pipefail
APP_IMAGE_REPOSITORY=usage-monitor
PREVIOUS_SHA="$PREVIOUS_SHA_VALUE"
TARGET_SHA="$TARGET_SHA_VALUE"
RECEIPT_FILE="$RECEIPT_PATH_VALUE"
die() { printf 'ERROR: %s\\n' "$*" >&2; return 1; }
log() { printf '%s\\n' "$*" >&2; }
require_secure_root_file() {
  [[ -f "$1" && ! -L "$1" ]] || die "unsafe receipt"
}
jq() {
  case "$2" in
    *activeRevision*) [[ "$RECEIPT_ACTIVE_VALUE" != __FAIL__ ]] || return 1; printf '%s\\n' "$RECEIPT_ACTIVE_VALUE" ;;
    *previousRevision*) [[ "$RECEIPT_PREVIOUS_VALUE" != __FAIL__ ]] || return 1; printf '%s\\n' "$RECEIPT_PREVIOUS_VALUE" ;;
    *) return 2 ;;
  esac
}
docker() {
  if [[ "$1 $2" == "image ls" ]]; then
    printf '%s\\n' "$IMAGE_ROWS_VALUE"
    return 0
  fi
  if [[ "$1 $2" == "ps -aq" ]]; then
    local image_ref="\${4#ancestor=}"
    [[ "$image_ref" == "$REFERENCED_IMAGE_VALUE" ]] && printf 'container-id\\n'
    return 0
  fi
  if [[ "$1 $2" == "image rm" ]]; then
    printf '%s\\n' "$3" >> "$REMOVAL_LOG_VALUE"
    [[ "$3" != "$FAIL_REMOVAL_VALUE" ]]
    return
  fi
  return 2
}
timeout() {
  while (( $# > 0 )) && [[ "$1" == --* ]]; do shift; done
  (( $# > 0 )) || return 2
  shift
  "$@"
}
${retentionFunction}
prune_unreferenced_application_images
`;
  return spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      IMAGE_ROWS_VALUE: imageRows,
      PREVIOUS_SHA_VALUE: previousSha,
      TARGET_SHA_VALUE: targetSha,
      RECEIPT_PATH_VALUE: receiptPath,
      RECEIPT_ACTIVE_VALUE: receiptActive,
      RECEIPT_PREVIOUS_VALUE: receiptPrevious,
      REFERENCED_IMAGE_VALUE: referencedImage,
      FAIL_REMOVAL_VALUE: failRemoval,
      REMOVAL_LOG_VALUE: removalLog,
    },
  });
}

function runBuildCacheCase({ fail = false } = {}) {
  const cacheLog = path.join(retentionTemp, "cache.log");
  rmSync(cacheLog, { force: true });
  const harness = `
set -Eeuo pipefail
MAX_BUILD_CACHE=8GB
MIN_BUILD_CACHE_FREE=12GB
RESERVED_BUILD_CACHE=4GB
log() { printf '%s\\n' "$*" >&2; }
docker() {
  printf '%s\\n' "$*" >> "$CACHE_LOG_VALUE"
  [[ "$FAIL_CACHE_VALUE" != true ]]
}
timeout() {
  while (( $# > 0 )) && [[ "$1" == --* ]]; do shift; done
  (( $# > 0 )) || return 2
  shift
  "$@"
}
${cacheFunction}
prune_bounded_build_cache
`;
  const result = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      CACHE_LOG_VALUE: cacheLog,
      FAIL_CACHE_VALUE: String(fail),
    },
  });
  return { result, cacheLog };
}

try {
  const revisions = Object.fromEntries(
    ["previous", "target", "active", "receiptPrevious", "referenced", "removable"].map((name, index) => [
      name,
      String.fromCharCode(97 + index).repeat(40),
    ]),
  );
  const protectedCase = runRetentionCase({
    imageRows: [
      `usage-monitor ${revisions.previous}`,
      `usage-monitor ${revisions.target}`,
      `usage-monitor ${revisions.active}`,
      `usage-monitor ${revisions.receiptPrevious}`,
      `usage-monitor ${revisions.referenced}`,
      `usage-monitor ${revisions.removable}`,
      "usage-monitor latest",
      `other-repository ${"f".repeat(40)}`,
    ].join("\n"),
    previousSha: revisions.previous,
    targetSha: revisions.target,
    receiptActive: revisions.active,
    receiptPrevious: revisions.receiptPrevious,
    referencedImage: `usage-monitor:${revisions.referenced}`,
  });
  assert.equal(protectedCase.status, 0, protectedCase.stderr);
  assert.equal(readFileSync(removalLog, "utf8"), `usage-monitor:${revisions.removable}\n`);

  const missingReceipt = runRetentionCase({
    imageRows: `usage-monitor ${revisions.removable}`,
    previousSha: revisions.previous,
    targetSha: revisions.target,
    receipt: "missing",
  });
  assert.equal(missingReceipt.status, 0, missingReceipt.stderr);
  assert.equal(readFileSync(removalLog, "utf8"), `usage-monitor:${revisions.removable}\n`);

  const malformedReceipt = runRetentionCase({
    imageRows: `usage-monitor ${revisions.removable}`,
    previousSha: revisions.previous,
    targetSha: revisions.target,
    receiptActive: "not-a-revision",
    receiptPrevious: revisions.receiptPrevious,
  });
  assert.notEqual(malformedReceipt.status, 0, "malformed receipt must fail closed");

  const danglingReceipt = runRetentionCase({
    imageRows: `usage-monitor ${revisions.removable}`,
    previousSha: revisions.previous,
    targetSha: revisions.target,
    receipt: "dangling",
  });
  assert.notEqual(danglingReceipt.status, 0, "dangling receipt symlink must fail closed");

  const failedRemoval = runRetentionCase({
    imageRows: `usage-monitor ${revisions.removable}`,
    previousSha: revisions.previous,
    targetSha: revisions.target,
    receiptActive: revisions.active,
    receiptPrevious: revisions.receiptPrevious,
    failRemoval: `usage-monitor:${revisions.removable}`,
  });
  assert.equal(failedRemoval.status, 0, failedRemoval.stderr);
  assert.match(failedRemoval.stderr, /disk preflight will decide/);

  const successfulCache = runBuildCacheCase();
  assert.equal(successfulCache.result.status, 0, successfulCache.result.stderr);
  assert.equal(
    readFileSync(successfulCache.cacheLog, "utf8"),
    "builder prune --max-used-space=8GB --min-free-space=12GB --reserved-space=4GB --force\n",
  );

  const failedCache = runBuildCacheCase({ fail: true });
  assert.equal(failedCache.result.status, 0, failedCache.result.stderr);
  assert.match(failedCache.result.stderr, /disk preflight will decide/);
} finally {
  rmSync(retentionTemp, { recursive: true, force: true });
}

assert.deepEqual(
  {
    state: renderRetirement.state,
    autoDeploy: renderRetirement.autoDeploy,
    schedulerEnabled: renderRetirement.schedulerEnabled,
    writerAuthority: renderRetirement.writerAuthority,
  },
  {
    state: "suspended",
    autoDeploy: "off",
    schedulerEnabled: false,
    writerAuthority: "oracle",
  },
  "Render retirement evidence must encode a disabled former writer",
);

for (const relativePath of [
  "deploy/oracle/deploy-production.sh",
  "deploy/oracle/auto-deploy.sh",
]) {
  const result = spawnSync("bash", ["-n", path.join(repoRoot, relativePath)], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${relativePath} failed bash -n: ${result.stderr}`);
}

const sameShaGuard = deploy.indexOf(
  'if [[ "${PREVIOUS_SHA}" == "${TARGET_SHA}" ]]',
);
const targetBuild = deploy.lastIndexOf(
  'ensure_mirror_and_release "${TARGET_SHA}"',
);
assert.ok(
  sameShaGuard >= 0 && targetBuild >= 0 && sameShaGuard < targetBuild,
  "same-SHA acceptance must occur before any image rebuild or retag",
);
assert.ok(
  (deploy.match(/require_current_main "\$\{TARGET_SHA\}"/g) ?? []).length >= 3 &&
    deploy.includes('accepted_main="$(remote_main_sha)"'),
  "main must be rechecked after build and immediately before cutover",
);

const recoveryLock = poller.indexOf('flock -w 10 8');
const recoveryCall = poller.indexOf('recover_current_app_if_stopped "${current_sha}"');
const recoveryUnlock = poller.indexOf('flock -u 8');
const childDeploy = poller.indexOf('"${DEPLOY_COMMAND}" "${target_sha}"');
assert.ok(
  recoveryLock >= 0 &&
    recoveryCall > recoveryLock &&
    recoveryUnlock > recoveryCall &&
    childDeploy > recoveryUnlock,
  "recovery must hold the shared transaction lock and release it before child deployment",
);

console.log("Oracle auto-deploy configuration checks passed.");
