import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

type Scope = "st" | "ct" | "shared";

const ENCRYPTION_KEY = "57".repeat(32);
const SOURCE_ENV: Record<
  Scope,
  {
    clientId: string;
    clientSecret: string;
    clientIdEnv: string;
    clientSecretEnv: string;
    projectIdEnv: string;
    pathEnv: string;
    projectId: string;
    secretPath: string;
  }
> = {
  st: {
    clientId: "test-client-st",
    clientSecret: "test-bootstrap-st",
    clientIdEnv: "INFISICAL_ST_CLIENT_ID",
    clientSecretEnv: "INFISICAL_ST_CLIENT_SECRET",
    projectIdEnv: "INFISICAL_ST_PROJECT_ID",
    pathEnv: "INFISICAL_ST_SECRET_PATH",
    projectId: "test-project-st",
    secretPath: "/st-scope",
  },
  ct: {
    clientId: "test-client-ct",
    clientSecret: "test-bootstrap-ct",
    clientIdEnv: "INFISICAL_CT_CLIENT_ID",
    clientSecretEnv: "INFISICAL_CT_CLIENT_SECRET",
    projectIdEnv: "INFISICAL_CT_PROJECT_ID",
    pathEnv: "INFISICAL_CT_SECRET_PATH",
    projectId: "test-project-ct",
    secretPath: "/ct-scope",
  },
  shared: {
    clientId: "test-client-shared",
    clientSecret: "test-bootstrap-shared",
    clientIdEnv: "INFISICAL_SHARED_CLIENT_ID",
    clientSecretEnv: "INFISICAL_SHARED_CLIENT_SECRET",
    projectIdEnv: "INFISICAL_SHARED_PROJECT_ID",
    pathEnv: "INFISICAL_SHARED_SECRET_PATH",
    projectId: "test-project-shared",
    secretPath: "/shared-scope",
  },
};

const ALLOWLIST: Record<Scope, readonly string[]> = {
  st: [
    "DEEPSEEK_API_KEY",
    "HETZNER_API_TOKEN",
    "PINECONE_API_KEY",
    "RESEND_API_KEY",
    "SENTRY_AUTH_TOKEN",
    "SENTRY_ORG",
  ],
  ct: [
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "INTRINIO_API_KEY",
    "LLAMAPARSE_API_KEY",
    "MISTRAL_API_KEY",
    "OPENAI_API_KEY",
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
    "TWELVEDATA_API_KEY",
  ],
  shared: [
    "LANGFUSE_BASE_URL",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "RESEND_API_KEY",
    "TWELVEDATA_API_KEY",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
  ],
};

interface SecretRead {
  source: Scope;
  name: string;
  projectId: string | null;
  environment: string | null;
  secretPath: string | null;
  includeImports: string | null;
}

interface ScopeRead {
  source: Scope;
  projectId: string | null;
  environment: string | null;
  secretPath: string | null;
  viewSecretValue: string | null;
  expandSecretReferences: string | null;
  recursive: string | null;
  includePersonalOverrides: string | null;
  includeImports: string | null;
}

let testDir: string;
let prisma: typeof import("@/lib/prisma").prisma;
let decrypt: typeof import("@/lib/crypto").decrypt;
let decryptJson: typeof import("@/lib/crypto").decryptJson;
let encrypt: typeof import("@/lib/crypto").encrypt;
let syncProviderCredentialsFromInfisical: typeof import("@/lib/infisical-provider-sync").syncProviderCredentialsFromInfisical;

function clearSyncEnvironment(): void {
  for (const config of Object.values(SOURCE_ENV)) {
    delete process.env[config.clientIdEnv];
    delete process.env[config.clientSecretEnv];
    delete process.env[config.projectIdEnv];
    delete process.env[config.pathEnv];
  }
  delete process.env.INFISICAL_BASE_URL;
  delete process.env.INFISICAL_ENV;
  delete process.env.INFISICAL_PROVIDER_SYNC_ENABLED;
}

function configureSources(...sources: Scope[]): void {
  process.env.INFISICAL_PROVIDER_SYNC_ENABLED = "true";
  process.env.INFISICAL_ENV = "prod";
  for (const source of sources) {
    const config = SOURCE_ENV[source];
    process.env[config.clientIdEnv] = config.clientId;
    process.env[config.clientSecretEnv] = config.clientSecret;
    process.env[config.projectIdEnv] = config.projectId;
    process.env[config.pathEnv] = config.secretPath;
  }
}

function sourceForClientId(clientId: unknown): Scope | undefined {
  return (Object.entries(SOURCE_ENV) as [Scope, (typeof SOURCE_ENV)[Scope]][])
    .find(([, config]) => config.clientId === clientId)?.[0];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installInfisicalMock(
  secrets: Partial<Record<Scope, Record<string, string>>>,
  options: {
    authStatus?: Partial<Record<Scope, number>>;
    scopeStatus?: Partial<Record<Scope, number>>;
    rejectedSecrets?: Partial<Record<Scope, readonly string[]>>;
    oversizedLogin?: Scope;
  } = {}
): {
  loginSources: Scope[];
  scopeReads: ScopeRead[];
  secretReads: SecretRead[];
  redirects: Array<RequestRedirect | undefined>;
  readonly oversizedBodyCanceled: boolean;
} {
  const loginSources: Scope[] = [];
  const scopeReads: ScopeRead[] = [];
  const secretReads: SecretRead[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  let oversizedBodyCanceled = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      redirects.push(init?.redirect);
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url
      );
      if (url.pathname === "/api/v1/auth/universal-auth/login") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          clientId?: unknown;
          clientSecret?: unknown;
        };
        const source = sourceForClientId(body.clientId);
        if (!source || body.clientSecret !== SOURCE_ENV[source].clientSecret) {
          return jsonResponse({ error: "unauthorized" }, 401);
        }
        loginSources.push(source);
        const failureStatus = options.authStatus?.[source];
        if (failureStatus) return jsonResponse({ error: "auth failed" }, failureStatus);
        if (options.oversizedLogin === source) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(128 * 1024 + 1));
              },
              cancel() {
                oversizedBodyCanceled = true;
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return jsonResponse({ accessToken: `test-token-${source}` });
      }

      const authorization = new Headers(init?.headers).get("authorization");
      const source = authorization?.replace("Bearer test-token-", "") as Scope;
      if (!(source in SOURCE_ENV)) {
        return jsonResponse({ error: "unexpected request" }, 404);
      }
      if (url.pathname === "/api/v4/secrets") {
        scopeReads.push({
          source,
          projectId: url.searchParams.get("projectId"),
          environment: url.searchParams.get("environment"),
          secretPath: url.searchParams.get("secretPath"),
          viewSecretValue: url.searchParams.get("viewSecretValue"),
          expandSecretReferences: url.searchParams.get("expandSecretReferences"),
          recursive: url.searchParams.get("recursive"),
          includePersonalOverrides: url.searchParams.get("includePersonalOverrides"),
          includeImports: url.searchParams.get("includeImports"),
        });
        const failureStatus = options.scopeStatus?.[source];
        return failureStatus
          ? jsonResponse({ error: "scope inaccessible" }, failureStatus)
          : jsonResponse({
              secrets: Object.keys(secrets[source] ?? {}).map((secretKey) => ({
                secretKey,
              })),
            });
      }

      const prefix = "/api/v4/secrets/";
      if (!url.pathname.startsWith(prefix)) {
        return jsonResponse({ error: "unexpected request" }, 404);
      }
      const name = decodeURIComponent(url.pathname.slice(prefix.length));
      secretReads.push({
        source,
        name,
        projectId: url.searchParams.get("projectId"),
        environment: url.searchParams.get("environment"),
        secretPath: url.searchParams.get("secretPath"),
        includeImports: url.searchParams.get("includeImports"),
      });
      if (options.rejectedSecrets?.[source]?.includes(name)) {
        throw new Error("simulated network failure");
      }
      const value = secrets[source]?.[name];
      return value === undefined
        ? jsonResponse({ error: "not found" }, 404)
        : jsonResponse({ secret: { secretValue: value } });
    })
  );
  return {
    loginSources,
    scopeReads,
    secretReads,
    redirects,
    get oversizedBodyCanceled() {
      return oversizedBodyCanceled;
    },
  };
}

function valuesFor(source: Scope): Record<string, string> {
  return Object.fromEntries(
    ALLOWLIST[source].map((name) => [
      name,
      name === "LANGFUSE_BASE_URL"
        ? "https://langfuse.example.test"
        : `${source}-${name.toLowerCase()}-test-material`,
    ])
  );
}

function expectRedacted(result: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(result);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "infisical-provider-sync-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ decrypt, decryptJson, encrypt } = await import("@/lib/crypto"));
  ({ syncProviderCredentialsFromInfisical } = await import(
    "@/lib/infisical-provider-sync"
  ));
}, 60_000);

beforeEach(async () => {
  clearSyncEnvironment();
  await prisma.provider.deleteMany();
  await prisma.project.deleteMany();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma?.$disconnect();
  clearSyncEnvironment();
  delete process.env.ENCRYPTION_KEY;
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

describe("Infisical provider credential sync", () => {
  it("reads only the functional allowlist and preserves three scopes", async () => {
    configureSources("st", "ct", "shared");
    const secrets = {
      st: valuesFor("st"),
      ct: valuesFor("ct"),
      shared: valuesFor("shared"),
    };
    const capture = installInfisicalMock(secrets);

    const result = await syncProviderCredentialsFromInfisical();

    expect(capture.loginSources.sort()).toEqual(["ct", "shared", "st"]);
    expect(new Set(capture.redirects)).toEqual(new Set(["error"]));
    for (const source of ["st", "ct", "shared"] as const) {
      expect(capture.scopeReads.filter((read) => read.source === source)).toEqual([
        {
          source,
          projectId: SOURCE_ENV[source].projectId,
          environment: "prod",
          secretPath: SOURCE_ENV[source].secretPath,
          viewSecretValue: "false",
          expandSecretReferences: "false",
          recursive: "false",
          includePersonalOverrides: "false",
          includeImports: "false",
        },
      ]);
      const reads = capture.secretReads.filter((read) => read.source === source);
      expect(reads.map((read) => read.name).sort()).toEqual(
        [...ALLOWLIST[source]].sort()
      );
      for (const read of reads) {
        expect(read.projectId).toBe(SOURCE_ENV[source].projectId);
        expect(read.environment).toBe("prod");
        expect(read.secretPath).toBe(SOURCE_ENV[source].secretPath);
        expect(read.includeImports).toBe("false");
      }
    }
    expect(result).toMatchObject({
      enabled: true,
      configured: true,
      created: 16,
      updated: 0,
      unchanged: 0,
      missing: 0,
      failed: 0,
    });
    expectRedacted(result, Object.values(secrets).flatMap(Object.values));

    const providers = await prisma.provider.findMany({
      include: { allocations: { include: { project: true } } },
    });
    expect(providers).toHaveLength(16);
    const deepseek = providers.filter((provider) => provider.name === "deepseek");
    expect(deepseek).toHaveLength(2);
    expect(
      deepseek.map((provider) => provider.allocations[0]?.project.name).sort()
    ).toEqual(["Congress.Trade", "SocraticTrade.com"]);
    expect(
      deepseek.map((provider) => decrypt(provider.apiKey!)).sort()
    ).toEqual([
      secrets.ct.DEEPSEEK_API_KEY,
      secrets.st.DEEPSEEK_API_KEY,
    ].sort());
    expect(
      providers.filter((provider) => provider.name === "resend")
    ).toHaveLength(2);
    expect(
      providers.filter((provider) => provider.name === "twelvedata")
    ).toHaveLength(1);
    const langfuse = providers.find((provider) => provider.name === "langfuse")!;
    expect(langfuse.secretConfig).not.toContain(secrets.shared.LANGFUSE_SECRET_KEY);
    expect(decryptJson(langfuse.secretConfig!)).toMatchObject({
      secretKey: secrets.shared.LANGFUSE_SECRET_KEY,
      infisicalCredential: {
        scope: "shared",
        source: "shared",
        providerName: "langfuse",
      },
    });
    expect(JSON.stringify(langfuse.config)).not.toContain("infisicalCredential");
  });

  it("uses shared only after a definite miss, then promotes the app key", async () => {
    configureSources("st", "ct", "shared");
    const st = valuesFor("st");
    delete st.RESEND_API_KEY;
    const firstSecrets = {
      st,
      ct: valuesFor("ct"),
      shared: valuesFor("shared"),
    };
    installInfisicalMock(firstSecrets);

    const first = await syncProviderCredentialsFromInfisical();
    expect(first.failed).toBe(0);
    const stProject = await prisma.project.findFirstOrThrow({
      where: { name: "SocraticTrade.com" },
    });
    const stResend = await prisma.provider.findFirstOrThrow({
      where: {
        name: "resend",
        allocations: { some: { projectId: stProject.id } },
      },
    });
    expect(decrypt(stResend.apiKey!)).toBe(firstSecrets.shared.RESEND_API_KEY);
    expect(decryptJson(stResend.secretConfig!)).toMatchObject({
      infisicalCredential: { scope: "st", source: "shared" },
    });

    vi.unstubAllGlobals();
    const promotedStKey = "st-resend-promoted-secret";
    installInfisicalMock({
      ...firstSecrets,
      st: { ...st, RESEND_API_KEY: promotedStKey },
    });
    const second = await syncProviderCredentialsFromInfisical();

    expect(second.updated).toBe(1);
    expect(second.unchanged).toBe(15);
    const updated = await prisma.provider.findUniqueOrThrow({
      where: { id: stResend.id },
    });
    expect(decrypt(updated.apiKey!)).toBe(promotedStKey);
    expect(decryptJson(updated.secretConfig!)).toMatchObject({
      infisicalCredential: { scope: "st", source: "st" },
    });
  });

  it("retains last-known-good values on auth/read failures and redacts results", async () => {
    configureSources("st", "ct", "shared");
    const initial = {
      st: valuesFor("st"),
      ct: valuesFor("ct"),
      shared: valuesFor("shared"),
    };
    installInfisicalMock(initial);
    await syncProviderCredentialsFromInfisical();
    const stDeepseek = await prisma.provider.findFirstOrThrow({
      where: { name: "deepseek", label: "SocraticTrade.com" },
    });
    const original = decrypt(stDeepseek.apiKey!);

    vi.unstubAllGlobals();
    const rotated = "must-not-replace-after-auth-failure";
    installInfisicalMock(
      { ...initial, shared: { ...initial.shared, DEEPSEEK_API_KEY: rotated } },
      { authStatus: { st: 401 } }
    );
    const result = await syncProviderCredentialsFromInfisical();

    expect(result.failed).toBeGreaterThan(0);
    expectRedacted(result, [original, rotated, SOURCE_ENV.st.clientSecret]);
    const preserved = await prisma.provider.findUniqueOrThrow({
      where: { id: stDeepseek.id },
    });
    expect(decrypt(preserved.apiKey!)).toBe(original);
  });

  it("does not adopt an unscoped legacy app row when the sibling scope fails auth", async () => {
    configureSources("st", "ct");
    const legacyKey = "legacy-socratic-deepseek-key";
    const existing = await prisma.provider.create({
      data: {
        name: "deepseek",
        displayName: "DeepSeek",
        type: "builtin",
        label: "legacy service account",
        apiKey: encrypt(legacyKey),
      },
    });
    const ct = valuesFor("ct");
    installInfisicalMock({ ct }, { authStatus: { st: 401 } });

    const result = await syncProviderCredentialsFromInfisical();

    expect(result.failed).toBeGreaterThan(0);
    const preserved = await prisma.provider.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(decrypt(preserved.apiKey!)).toBe(legacyKey);
    expect(preserved.secretConfig).toBeNull();
    const deepseek = await prisma.provider.findMany({
      where: { name: "deepseek" },
      include: { allocations: { include: { project: true } } },
    });
    expect(deepseek).toHaveLength(2);
    expect(
      deepseek.some(
        (provider) =>
          provider.id !== existing.id &&
          decrypt(provider.apiKey!) === ct.DEEPSEEK_API_KEY &&
          provider.allocations[0]?.project.name === "Congress.Trade"
      )
    ).toBe(true);
  });

  it("retains last-known-good app credentials when scope preflight is inaccessible", async () => {
    configureSources("st", "shared");
    const initial = {
      st: valuesFor("st"),
      shared: valuesFor("shared"),
    };
    installInfisicalMock(initial);
    await syncProviderCredentialsFromInfisical();
    const stProject = await prisma.project.findFirstOrThrow({
      where: { name: "SocraticTrade.com" },
    });
    const stResend = await prisma.provider.findFirstOrThrow({
      where: {
        name: "resend",
        allocations: { some: { projectId: stProject.id } },
      },
    });
    const original = decrypt(stResend.apiKey!);

    vi.unstubAllGlobals();
    const rotatedShared = "shared-resend-must-not-promote";
    const capture = installInfisicalMock(
      {
        ...initial,
        shared: { ...initial.shared, RESEND_API_KEY: rotatedShared },
      },
      { scopeStatus: { st: 404 } }
    );
    const result = await syncProviderCredentialsFromInfisical();

    expect(result.sources.find((source) => source.source === "st")).toMatchObject({
      configured: true,
      status: "error",
      errorCode: "scope_http_404",
    });
    expect(capture.secretReads.some((read) => read.source === "st")).toBe(false);
    const preserved = await prisma.provider.findUniqueOrThrow({
      where: { id: stResend.id },
    });
    expect(decrypt(preserved.apiKey!)).toBe(original);
    expect(decryptJson(preserved.secretConfig!)).toMatchObject({
      infisicalCredential: { scope: "st", source: "st" },
    });
    expectRedacted(result, [original, rotatedShared]);
  });

  it("cancels an oversized streamed response before buffering the body", async () => {
    configureSources("st");
    const capture = installInfisicalMock(
      { st: valuesFor("st") },
      { oversizedLogin: "st" }
    );

    const result = await syncProviderCredentialsFromInfisical();

    expect(result.sources.find((source) => source.source === "st")).toMatchObject({
      configured: true,
      status: "error",
      errorCode: "response_too_large",
    });
    expect(capture.oversizedBodyCanceled).toBe(true);
    expect(capture.scopeReads).toHaveLength(0);
    expect(capture.secretReads).toHaveLength(0);
  });

  it("selects the exact current-key duplicate and never adopts an old label", async () => {
    configureSources("st", "ct", "shared");
    const secrets = {
      st: valuesFor("st"),
      ct: valuesFor("ct"),
      shared: valuesFor("shared"),
    };
    const oldCt = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        label: "OLD Congress.Trade",
        apiKey: encrypt("old-congress-gemini-key"),
      },
    });
    const currentCt = await prisma.provider.create({
      data: {
        name: "gemini",
        displayName: "Gemini",
        type: "builtin",
        label: "Congress.Trade",
        apiKey: encrypt(secrets.ct.GEMINI_API_KEY),
      },
    });
    const oldSt = await prisma.provider.create({
      data: {
        name: "deepseek",
        displayName: "DeepSeek",
        type: "builtin",
        label: "Socratic Trade (old)",
        apiKey: encrypt("old-socratic-deepseek-key"),
      },
    });
    const currentSt = await prisma.provider.create({
      data: {
        name: "deepseek",
        displayName: "DeepSeek",
        type: "builtin",
        label: "SocraticTrade.com",
        apiKey: encrypt(secrets.st.DEEPSEEK_API_KEY),
      },
    });
    installInfisicalMock(secrets);

    const result = await syncProviderCredentialsFromInfisical();

    expect(result.failed).toBe(0);
    const providers = await prisma.provider.findMany({
      where: { id: { in: [oldCt.id, currentCt.id, oldSt.id, currentSt.id] } },
    });
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    expect(byId.get(oldCt.id)?.secretConfig).toBeNull();
    expect(byId.get(oldSt.id)?.secretConfig).toBeNull();
    expect(decryptJson(byId.get(currentCt.id)!.secretConfig!)).toMatchObject({
      infisicalCredential: { scope: "ct", providerName: "google-ai" },
    });
    expect(decryptJson(byId.get(currentSt.id)!.secretConfig!)).toMatchObject({
      infisicalCredential: { scope: "st", providerName: "deepseek" },
    });
    expect(
      await prisma.provider.count({
        where: {
          type: "builtin",
          OR: [{ name: "google-ai" }, { name: "gemini" }],
        },
      })
    ).toBe(2);
  });

  it("preserves a valid manual ST Gemini row when only CT has an Infisical key", async () => {
    configureSources("ct");
    const ct = valuesFor("ct");
    const manualStKey = "manual-socratic-gemini-key";
    const stProvider = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        label: "SocraticTrade.com",
        apiKey: encrypt(manualStKey),
      },
    });
    installInfisicalMock({ ct });

    await syncProviderCredentialsFromInfisical();

    const preserved = await prisma.provider.findUniqueOrThrow({
      where: { id: stProvider.id },
    });
    expect(decrypt(preserved.apiKey!)).toBe(manualStKey);
    expect(preserved.secretConfig).toBeNull();
    const googleProviders = await prisma.provider.findMany({
      where: { name: "google-ai" },
    });
    expect(googleProviders).toHaveLength(2);
    expect(
      googleProviders.some(
        (provider) => provider.id !== stProvider.id && decrypt(provider.apiKey!) === ct.GEMINI_API_KEY
      )
    ).toBe(true);
  });

  it("adopts an exact Resend domain row instead of creating a duplicate", async () => {
    configureSources("st", "ct", "shared");
    const secrets = {
      st: valuesFor("st"),
      ct: valuesFor("ct"),
      shared: valuesFor("shared"),
    };
    const existing = await prisma.provider.create({
      data: {
        name: "resend",
        displayName: "Resend",
        type: "builtin",
        label: "updates.jays.services",
        apiKey: encrypt(secrets.st.RESEND_API_KEY),
      },
    });
    installInfisicalMock(secrets);

    const result = await syncProviderCredentialsFromInfisical();

    expect(result.failed).toBe(0);
    const adopted = await prisma.provider.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(decrypt(adopted.apiKey!)).toBe(secrets.st.RESEND_API_KEY);
    expect(decryptJson(adopted.secretConfig!)).toMatchObject({
      infisicalCredential: { scope: "st", source: "st", providerName: "resend" },
    });
    // One adopted ST row plus one distinct CT row; no third duplicate.
    expect(await prisma.provider.count({ where: { name: "resend" } })).toBe(2);
  });

  it("fails safely on ambiguous old/current labels without creating a duplicate", async () => {
    configureSources("st");
    const secrets = { st: valuesFor("st") };
    await prisma.provider.createMany({
      data: [
        {
          name: "deepseek",
          displayName: "DeepSeek",
          type: "builtin",
          label: "SocraticTrade.com",
          apiKey: encrypt("different-one"),
        },
        {
          name: "deepseek",
          displayName: "DeepSeek",
          type: "builtin",
          label: "Socratic Trade (old)",
          apiKey: encrypt("different-two"),
        },
      ],
    });
    installInfisicalMock(secrets);

    const result = await syncProviderCredentialsFromInfisical();

    // The ambiguous ST row and every intentionally unconfigured CT/shared
    // mapping fail closed; none may mutate or create a provider.
    expect(result.failed).toBeGreaterThan(0);
    expect(await prisma.provider.count({ where: { name: "deepseek" } })).toBe(2);
    expect(
      await prisma.provider.count({
        where: { name: "deepseek", secretConfig: { not: null } },
      })
    ).toBe(0);
  });

  it("is a no-op when disabled or no machine identity is configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    process.env.INFISICAL_PROVIDER_SYNC_ENABLED = "false";
    const disabled = await syncProviderCredentialsFromInfisical();
    expect(disabled).toMatchObject({ enabled: false, configured: false });

    delete process.env.INFISICAL_PROVIDER_SYNC_ENABLED;
    const absent = await syncProviderCredentialsFromInfisical();
    expect(absent).toMatchObject({ enabled: true, configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await prisma.provider.count()).toBe(0);
  });

  it("rejects a non-Infisical base URL before sending bootstrap credentials", async () => {
    configureSources("st");
    process.env.INFISICAL_BASE_URL = "https://127.0.0.1/internal";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await syncProviderCredentialsFromInfisical();

    expect(result.failed).toBe(16);
    expect(result.sources[0]).toMatchObject({
      source: "st",
      status: "error",
      errorCode: "invalid_base_url",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
