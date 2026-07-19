import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

// Regression guard for the browser-extension credential-scraping containment.
// v1.0.0 of chrome-extension/ scraped document.cookie + full localStorage from
// provider dashboards and POSTed them (with a stored monitor token) to a
// nonexistent /api/ingest/keys endpoint under an <all_urls> grant. These tests
// lock in the least-privilege launcher and fail loudly if any scraping,
// exfiltration, or broad host access is reintroduced.

const extDir = path.join(process.cwd(), "chrome-extension");
const manifestPath = path.join(extDir, "manifest.json");

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

// Concatenate only the EXECUTABLE surface (js/html/json). The README is prose
// and legitimately documents the removed behavior, so it is not scanned.
function executableSource(): string {
  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|html|json)$/.test(entry.name)) chunks.push(readFileSync(p, "utf8"));
    }
  };
  walk(extDir);
  return chunks.join("\n");
}

describe("chrome-extension credential-scraping containment", () => {
  it("requests no broad host access", () => {
    const m = readManifest();
    const hosts = (m.host_permissions as string[] | undefined) ?? [];
    expect(hosts).not.toContain("<all_urls>");
    expect(hosts).toEqual([]); // a launcher needs no host permissions at all
  });

  it("injects no content scripts", () => {
    const m = readManifest();
    expect((m.content_scripts as unknown[] | undefined) ?? []).toEqual([]);
  });

  it("runs no background service worker", () => {
    const m = readManifest();
    expect(m.background).toBeUndefined();
  });

  it("holds only least-privilege permissions", () => {
    const m = readManifest();
    const perms = (m.permissions as string[] | undefined) ?? [];
    for (const forbidden of ["scripting", "activeTab", "webRequest", "cookies", "tabs"]) {
      expect(perms).not.toContain(forbidden);
    }
    // "storage" (for the non-secret dashboard URL) is the only thing allowed.
    for (const p of perms) expect(["storage"]).toContain(p);
  });

  it("removed the scraper content scripts and exfil background worker", () => {
    for (const f of ["scripts/anthropic.js", "scripts/openai.js", "scripts/background.js"]) {
      expect(existsSync(path.join(extDir, f))).toBe(false);
    }
  });

  it("captures no credentials and posts to no ingest sink", () => {
    const src = executableSource();
    expect(src).not.toMatch(/document\.cookie/);
    expect(src).not.toMatch(/localStorage/);
    expect(src).not.toMatch(/\/api\/ingest\/keys/);
    expect(src).not.toMatch(/SYNC_KEYS/);
    expect(src).not.toMatch(/chrome\.runtime\.onMessage/);
    expect(src).not.toMatch(/apiToken/);
  });
});
