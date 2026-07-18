import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "@/lib/adapters/oracle";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let reconcileProviderExternalBilling: typeof import("../provider-external-billing").reconcileProviderExternalBilling;
let providerId: string;

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const config = {
  tenancyOcid: "ocid1.tenancy.oc1..example",
  userOcid: "ocid1.user.oc1..example",
  fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99",
  privateKey,
  region: "us-chicago-1",
};

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oci-service-detail-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ reconcileProviderExternalBilling } = await import("../provider-external-billing"));
});

beforeEach(async () => {
  await prisma.providerExternalBilling.deleteMany();
  await prisma.provider.deleteMany();
  providerId = (await prisma.provider.create({ data: { name: "oracle", displayName: "OCI", type: "builtin" } })).id;
});

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

describe("OCI service-detail persistence", () => {
  it("preserves a prior complete service breakdown when later optional detail is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.groupBy.length === 0
        ? json({ items: [{ currency: "USD", computedAmount: 2 }] })
        : json({ items: [{ service: "Compute", currency: "USD", computedAmount: 2 }] });
    }));
    const complete = await fetchUsage("", config);
    for (const sync of complete.externalBillingSyncs ?? []) {
      await reconcileProviderExternalBilling(providerId, sync);
    }

    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.groupBy.length === 0
        ? json({ items: [{ currency: "USD", computedAmount: 3 }] })
        : json({ items: [{ service: "Compute", currency: "USD" }] });
    }));
    const incomplete = await fetchUsage("", config);
    expect(incomplete.externalBillingSyncs?.map((sync) => sync.source)).toEqual(["oci-usage-canonical"]);
    for (const sync of incomplete.externalBillingSyncs ?? []) {
      await reconcileProviderExternalBilling(providerId, sync);
    }

    expect(await prisma.providerExternalBilling.findMany({ orderBy: { source: "asc" } })).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "oci-usage-canonical", amountUsd: 3, rollupRole: "canonical" }),
      expect.objectContaining({ source: "oci-usage-service-detail", serviceName: "Compute", amountUsd: 2, rollupRole: "component" }),
    ]));
  });
});
