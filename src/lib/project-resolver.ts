import { prisma } from "@/lib/prisma";
import { canonicalProjectKey } from "@/lib/provider-identity";

/** Bound how many null-projectId rows we scan on Project create (Wave G / E6). */
const PROJECT_BACKFILL_SCAN_CAP = 50_000;
const PROJECT_BACKFILL_UPDATE_CHUNK = 500;

export interface ProjectIdentityCandidate {
  id: string;
  name: string;
  createdAt: Date | string;
}

/** Oldest canonical project wins, with id as a total-order tie-break. */
export function buildCanonicalProjectIdMap(
  projects: readonly ProjectIdentityCandidate[]
): Map<string, string> {
  const ordered = [...projects].sort((left, right) => {
    const byCreatedAt =
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
    return byCreatedAt || left.id.localeCompare(right.id);
  });
  const byName = new Map<string, string>();
  for (const project of ordered) {
    const key = canonicalProjectKey(project.name);
    if (key && !byName.has(key)) byName.set(key, project.id);
  }
  return byName;
}

// Resolves producer-supplied project identifiers (a plain name/key sent via
// OTEL_RESOURCE_ATTRIBUTES `project` for Claude Code, or the top-level
// `project` field on the generic ingest contract) to a Project.id.
//
// Matching is case-insensitive on Project.name. The Project table is tiny
// (one row per tracked project), so we fetch the candidates and match in JS
// rather than issuing one case-insensitive query per distinct name — SQLite
// has no reliable case-insensitive `IN` without a collation change.
//
// Unknown names resolve to nothing (the event's projectId stays null and the
// raw name is preserved in metadata so a Project created later can be
// back-filled). This keeps ingest decoupled from project existence: producers
// can tag freely and the owner creates Projects (with budgets) when ready.
export async function resolveProjectIdsByName(
  names: Iterable<string>
): Promise<Map<string, string>> {
  const wanted = new Set<string>();
  for (const name of names) {
    const key = canonicalProjectKey(name);
    if (key) wanted.add(key);
  }
  if (wanted.size === 0) return new Map();

  // Match on nameKey (the DB-unique lowercased name) when present, else fall
  // back to the lowercased display name for legacy rows created before the
  // nameKey column. Ordered by (createdAt, id) so that if a case-variant
  // collision somehow predates the uniqueness guard, the OLDEST project wins
  // deterministically — with id as a total-order tiebreak so even identical
  // createdAt timestamps can't make resolution non-deterministic.
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return new Map(
    [...buildCanonicalProjectIdMap(projects)].filter(([key]) => wanted.has(key))
  );
}

function projectNameFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as Record<string, unknown>).project;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

/**
 * Wave G / E6: when a Project is created, attach its id to raw
 * ExternalUsageEvent rows that still have projectId null but carry a matching
 * metadata.project name (case-insensitive via canonicalProjectKey).
 *
 * Does not rewrite historical daily rollups (those groupKey hashes already
 * include the prior null projectId). Fresh MTD and live budget sums read raw
 * rows inside the retention window and pick up the new projectId immediately.
 *
 * @returns number of raw rows updated
 */
export async function backfillProjectIdFromMetadataName(
  projectId: string,
  projectName: string
): Promise<number> {
  const nameKey = canonicalProjectKey(projectName);
  if (!nameKey || !projectId) return 0;

  const candidates = await prisma.externalUsageEvent.findMany({
    where: { projectId: null },
    select: { id: true, metadata: true },
    take: PROJECT_BACKFILL_SCAN_CAP,
    orderBy: { occurredAt: "desc" },
  });

  const matchingIds = candidates
    .filter((row) => {
      const rawName = projectNameFromMetadata(row.metadata);
      return rawName != null && canonicalProjectKey(rawName) === nameKey;
    })
    .map((row) => row.id);

  if (matchingIds.length === 0) return 0;

  let updated = 0;
  for (let i = 0; i < matchingIds.length; i += PROJECT_BACKFILL_UPDATE_CHUNK) {
    const chunk = matchingIds.slice(i, i + PROJECT_BACKFILL_UPDATE_CHUNK);
    const result = await prisma.externalUsageEvent.updateMany({
      where: { id: { in: chunk }, projectId: null },
      data: { projectId },
    });
    updated += result.count;
  }
  return updated;
}
