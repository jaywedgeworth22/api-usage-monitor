import { prisma } from "@/lib/prisma";

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
    const key = name.trim().toLowerCase();
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
    select: { id: true, name: true, nameKey: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const byName = new Map<string, string>();
  for (const project of projects) {
    const key = project.nameKey ?? project.name.trim().toLowerCase();
    if (wanted.has(key) && !byName.has(key)) byName.set(key, project.id);
  }
  return byName;
}
