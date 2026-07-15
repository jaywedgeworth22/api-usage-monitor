import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Prisma } from "@prisma/client";
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
import { geminiApiKeyFingerprint } from "../gemini-key-status";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

type Scope = "st" | "ct" | "shared";

const ENCRYPTION_KEY = "57".repeat(32);
const ST_GEMINI_PROVIDER_ID = "4a888d41-3988-4774-86d8-67d7aa14d7e2";
const ST_INFISICAL_PROJECT_ID = "39d93bb7-76f9-498c-8b50-a7def52e072f";
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
    "GEMINI_API_KEY",
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
    "FIRECRAWL_API_KEY",
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

interface SecretCreate {
  source: Scope;
  name: string;
  projectId: string | null;
  environment: string | null;
  secretPath: string | null;
  type: string | null;
  valueFingerprint: string;
}

const CREATE_RESPONSE_IDENTITY_CASES = [
  ["missing secretKey", "secretKey", undefined],
  ["mismatched secretKey", "secretKey", "WRONG_SECRET"],
  ["missing shared type", "type", undefined],
  ["mismatched shared type", "type", "personal"],
  ["missing workspace", "workspace", undefined],
  ["mismatched workspace", "workspace", "wrong-project"],
  ["missing environment", "environment", undefined],
  ["mismatched environment", "environment", "dev"],
] as const;

const READ_RESPONSE_IDENTITY_CASES = [
  ...CREATE_RESPONSE_IDENTITY_CASES,
  ["missing secretPath", "secretPath", undefined],
  ["mismatched secretPath", "secretPath", "/wrong"],
] as const;

let testDir: string;
let prisma: typeof import("@/lib/prisma").prisma;
let decrypt: typeof import("@/lib/crypto").decrypt;
let decryptJson: typeof import("@/lib/crypto").decryptJson;
let encrypt: typeof import("@/lib/crypto").encrypt;
let encryptJson: typeof import("@/lib/crypto").encryptJson;
let bootstrapStGeminiCredentialToInfisical: typeof import("@/lib/infisical-provider-sync").bootstrapStGeminiCredentialToInfisical;
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
  delete process.env.INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED;
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

function enableStGeminiBootstrap(): void {
  configureSources("st");
  process.env.INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED = "true";
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
    secretStatus?: Partial<Record<Scope, Partial<Record<string, number>>>>;
    createStatus?: number;
    oversizedCreate?: boolean;
    postCreateReadValue?: string;
    createResponseOverrides?: Record<string, unknown>;
    exactReadResponseOverrides?: Record<string, unknown>;
    afterFirstMissingStGeminiRead?: () => void | Promise<void>;
  } = {}
): {
  loginSources: Scope[];
  scopeReads: ScopeRead[];
  secretReads: SecretRead[];
  secretCreates: SecretCreate[];
  events: string[];
  redirects: Array<RequestRedirect | undefined>;
  readonly oversizedBodyCanceled: boolean;
  readonly oversizedCreateBodyCanceled: boolean;
} {
  const loginSources: Scope[] = [];
  const scopeReads: ScopeRead[] = [];
  const secretReads: SecretRead[] = [];
  const secretCreates: SecretCreate[] = [];
  const events: string[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  let oversizedBodyCanceled = false;
  let oversizedCreateBodyCanceled = false;
  let missingReadHookUsed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      redirects.push(init?.redirect);
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url
      );
      const method = (init?.method ?? "GET").toUpperCase();
      events.push(`${method} ${url.pathname}`);
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
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          projectId?: unknown;
          environment?: unknown;
          secretPath?: unknown;
          type?: unknown;
          secretValue?: unknown;
        };
        const secretValue =
          typeof body.secretValue === "string" ? body.secretValue : "";
        secretCreates.push({
          source,
          name,
          projectId: typeof body.projectId === "string" ? body.projectId : null,
          environment:
            typeof body.environment === "string" ? body.environment : null,
          secretPath:
            typeof body.secretPath === "string" ? body.secretPath : null,
          type: typeof body.type === "string" ? body.type : null,
          valueFingerprint: geminiApiKeyFingerprint(secretValue),
        });
        if (options.createStatus) {
          return jsonResponse({ error: "create failed" }, options.createStatus);
        }
        const sourceSecrets = (secrets[source] ??= {});
        if (sourceSecrets[name] !== undefined) {
          return jsonResponse({ error: "already exists" }, 409);
        }
        sourceSecrets[name] = options.postCreateReadValue ?? secretValue;
        if (options.oversizedCreate) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(128 * 1024 + 1));
              },
              cancel() {
                oversizedCreateBodyCanceled = true;
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return jsonResponse({
          secret: {
            secretKey: name,
            secretValue,
            type: "shared",
            workspace: body.projectId,
            environment: body.environment,
            ...options.createResponseOverrides,
          },
        });
      }
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
      const forcedStatus = options.secretStatus?.[source]?.[name];
      if (forcedStatus) {
        return jsonResponse({ error: "secret read failed" }, forcedStatus);
      }
      const value = secrets[source]?.[name];
      if (
        value === undefined &&
        source === "st" &&
        name === "GEMINI_API_KEY" &&
        !missingReadHookUsed &&
        options.afterFirstMissingStGeminiRead
      ) {
        missingReadHookUsed = true;
        await options.afterFirstMissingStGeminiRead();
      }
      return value === undefined
        ? jsonResponse({ error: "not found" }, 404)
        : jsonResponse({
            secret: {
              secretKey: name,
              secretValue: value,
              type: "shared",
              workspace: url.searchParams.get("projectId"),
              environment: url.searchParams.get("environment"),
              secretPath: url.searchParams.get("secretPath"),
              ...options.exactReadResponseOverrides,
            },
          });
    })
  );
  return {
    loginSources,
    scopeReads,
    secretReads,
    secretCreates,
    events,
    redirects,
    get oversizedBodyCanceled() {
      return oversizedBodyCanceled;
    },
    get oversizedCreateBodyCanceled() {
      return oversizedCreateBodyCanceled;
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

async function seedStGeminiProvider(
  options: {
    providerId?: string;
    key?: string | null;
    name?: string;
    type?: string;
    label?: string;
    isActive?: boolean;
    percentage?: number;
    projectName?: string;
    alertConfigGeneration?: number;
    secretConfig?: string | null;
    snapshotAt?: Date;
    validation?: Record<string, unknown> | null;
  } = {}
) {
  const key = options.key === undefined ? "current-st-gemini-key" : options.key;
  const project = await prisma.project.create({
    data: { name: options.projectName ?? "SocraticTrade.com" },
  });
  const provider = await prisma.provider.create({
    data: {
      id: options.providerId ?? ST_GEMINI_PROVIDER_ID,
      name: options.name ?? "google-ai",
      displayName: "Google AI",
      type: options.type ?? "builtin",
      label: options.label ?? "SocraticTrade.com",
      isActive: options.isActive ?? true,
      apiKey: key == null ? null : encrypt(key),
      alertConfigGeneration: options.alertConfigGeneration ?? 7,
      secretConfig: options.secretConfig,
      allocations: {
        create: { projectId: project.id, percentage: options.percentage ?? 100 },
      },
    },
  });
  if (options.validation !== null) {
    await prisma.usageSnapshot.create({
      data: {
        providerId: provider.id,
        fetchedAt: options.snapshotAt ?? new Date(),
        rawData: {
          keyValidation:
            options.validation ??
            ({
              ok: true,
              outcome: "valid",
              status: 200,
              credentialFingerprint:
                key == null ? null : geminiApiKeyFingerprint(key),
              availableModelCount: 50,
            } satisfies Record<string, unknown>),
        } as Prisma.InputJsonValue,
      },
    });
  }
  return { provider, project, key };
}

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "infisical-provider-sync-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ decrypt, decryptJson, encrypt, encryptJson } = await import("@/lib/crypto"));
  ({
    bootstrapStGeminiCredentialToInfisical,
    syncProviderCredentialsFromInfisical,
  } = await import("@/lib/infisical-provider-sync"));
}, 60_000);

beforeEach(async () => {
  clearSyncEnvironment();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  await prisma.provider.deleteMany();
  await prisma.project.deleteMany();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
      created: 18,
      updated: 0,
      unchanged: 0,
      missing: 0,
      failed: 0,
    });
    expectRedacted(result, Object.values(secrets).flatMap(Object.values));

    const providers = await prisma.provider.findMany({
      include: { allocations: { include: { project: true } } },
    });
    expect(providers).toHaveLength(18);
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
    const googleAi = providers.filter((provider) => provider.name === "google-ai");
    expect(googleAi).toHaveLength(2);
    expect(
      googleAi.map((provider) => provider.allocations[0]?.project.name).sort()
    ).toEqual(["Congress.Trade", "SocraticTrade.com"]);
    expect(
      googleAi.map((provider) => decrypt(provider.apiKey!)).sort()
    ).toEqual([
      secrets.ct.GEMINI_API_KEY,
      secrets.st.GEMINI_API_KEY,
    ].sort());
    expect(
      providers.filter((provider) => provider.name === "twelvedata")
    ).toHaveLength(1);
    const firecrawl = providers.find((provider) => provider.name === "firecrawl")!;
    expect(decrypt(firecrawl.apiKey!)).toBe(secrets.shared.FIRECRAWL_API_KEY);
    expect(decryptJson(firecrawl.secretConfig!)).toMatchObject({
      infisicalCredential: {
        scope: "shared",
        source: "shared",
        providerName: "firecrawl",
      },
    });
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
    expect(second.unchanged).toBe(17);
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
    ).toBe(3);
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

  it("keeps static ST/CT Gemini multiplicity when the ST source is unconfigured", async () => {
    configureSources("ct");
    const ct = valuesFor("ct");
    const legacyKey = "unscoped-gemini-key";
    const existing = await prisma.provider.create({
      data: {
        name: "google-ai",
        displayName: "Google AI",
        type: "builtin",
        label: "primary Gemini account",
        apiKey: encrypt(legacyKey),
      },
    });
    installInfisicalMock({ ct });

    await syncProviderCredentialsFromInfisical();

    const preserved = await prisma.provider.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(decrypt(preserved.apiKey!)).toBe(legacyKey);
    expect(preserved.secretConfig).toBeNull();
    const googleProviders = await prisma.provider.findMany({
      where: { name: "google-ai" },
      include: { allocations: { include: { project: true } } },
    });
    expect(googleProviders).toHaveLength(2);
    expect(
      googleProviders.some(
        (provider) =>
          provider.id !== existing.id &&
          decrypt(provider.apiKey!) === ct.GEMINI_API_KEY &&
          provider.allocations[0]?.project.name === "Congress.Trade"
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

    expect(result.failed).toBe(18);
    expect(result.sources[0]).toMatchObject({
      source: "st",
      status: "error",
      errorCode: "invalid_base_url",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps ordinary non-bootstrap reads compatible when response identity metadata is absent", async () => {
    configureSources("st");
    const deepseekKey = "ordinary-read-with-value-only-response";
    installInfisicalMock(
      { st: { DEEPSEEK_API_KEY: deepseekKey } },
      {
        exactReadResponseOverrides: {
          secretKey: undefined,
          type: undefined,
          workspace: undefined,
          environment: undefined,
          secretPath: undefined,
        },
      }
    );

    const result = await syncProviderCredentialsFromInfisical();

    expect(result.created).toBe(1);
    const provider = await prisma.provider.findFirstOrThrow({
      where: { name: "deepseek" },
    });
    expect(decrypt(provider.apiKey!)).toBe(deepseekKey);
  });
});

describe("one-time ST Gemini Infisical bootstrap", () => {
  it("is default-off and performs no network or provider write", async () => {
    const { provider } = await seedStGeminiProvider();
    const before = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await bootstrapStGeminiCredentialToInfisical();

    expect(result).toEqual({
      enabled: false,
      attempted: false,
      providerId: ST_GEMINI_PROVIDER_ID,
      status: "disabled",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const after = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(after).toMatchObject({
      apiKey: before.apiKey,
      secretConfig: before.secretConfig,
      alertConfigGeneration: before.alertConfigGeneration,
    });
    expect(console.info).not.toHaveBeenCalled();
  });

  it("accepts the real path-less create response, verifies the fixed secret, then the normal pull binds it", async () => {
    enableStGeminiBootstrap();
    const { provider, key } = await seedStGeminiProvider();
    const secrets: Partial<Record<Scope, Record<string, string>>> = { st: {} };
    const capture = installInfisicalMock(secrets);

    const bootstrap = await bootstrapStGeminiCredentialToInfisical();

    expect(bootstrap).toEqual({
      enabled: true,
      attempted: true,
      providerId: ST_GEMINI_PROVIDER_ID,
      status: "created",
    });
    expect(capture.secretCreates).toEqual([
      {
        source: "st",
        name: "GEMINI_API_KEY",
        projectId: ST_INFISICAL_PROJECT_ID,
        environment: "prod",
        secretPath: "/",
        type: "shared",
        valueFingerprint: geminiApiKeyFingerprint(key!),
      },
    ]);
    expect(capture.scopeReads[0]).toMatchObject({
      source: "st",
      projectId: ST_INFISICAL_PROJECT_ID,
      environment: "prod",
      secretPath: "/",
      viewSecretValue: "false",
      expandSecretReferences: "false",
      recursive: "false",
      includePersonalOverrides: "false",
      includeImports: "false",
    });
    expect(new Set(capture.redirects)).toEqual(new Set(["error"]));
    expectRedacted(bootstrap, [key!, SOURCE_ENV.st.clientSecret]);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(key);

    const createIndex = capture.events.indexOf(
      "POST /api/v4/secrets/GEMINI_API_KEY"
    );
    expect(capture.events[createIndex + 1]).toBe(
      "GET /api/v4/secrets/GEMINI_API_KEY"
    );
    const pullStart = capture.events.length;
    const sync = await syncProviderCredentialsFromInfisical();
    expect(createIndex).toBeGreaterThan(-1);
    expect(
      capture.events
        .slice(pullStart)
        .includes("GET /api/v4/secrets/GEMINI_API_KEY")
    ).toBe(true);
    expect(sync.updated).toBe(1);
    const bound = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(decrypt(bound.apiKey!)).toBe(key);
    expect(decryptJson(bound.secretConfig!)).toMatchObject({
      infisicalCredential: {
        scope: "st",
        source: "st",
        providerName: "google-ai",
      },
    });
    expect(bound.alertConfigGeneration).toBe(8);
    expect(await prisma.provider.count({ where: { name: "google-ai" } })).toBe(1);
  });

  it("requires the ST identity when explicitly enabled", async () => {
    process.env.INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED = "true";
    await seedStGeminiProvider();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await bootstrapStGeminiCredentialToInfisical();

    expect(result).toMatchObject({
      enabled: true,
      attempted: false,
      status: "unconfigured",
      errorCode: "st_identity_unconfigured",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong UUID", { providerId: "different-provider" }, "provider_not_found"],
    ["inactive provider", { isActive: false }, "provider_inactive"],
    ["non-builtin provider", { type: "custom" }, "provider_not_builtin"],
    ["wrong provider family", { name: "openai" }, "provider_name_mismatch"],
    ["historical label", { label: "OLD SocraticTrade.com" }, "historical_provider"],
    ["partial allocation", { percentage: 50 }, "project_allocation_mismatch"],
    ["wrong project", { projectName: "Congress.Trade" }, "project_allocation_mismatch"],
    ["missing credential", { key: null }, "credential_missing"],
    ["missing validation", { validation: null }, "validation_missing"],
    [
      "stale validation",
      { snapshotAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      "validation_stale",
    ],
    [
      "unsuccessful validation",
      {
        validation: {
          ok: false,
          outcome: "invalid",
          status: 403,
          credentialFingerprint: geminiApiKeyFingerprint("current-st-gemini-key"),
        },
      },
      "validation_unsuccessful",
    ],
    [
      "different validated credential",
      {
        validation: {
          ok: true,
          outcome: "valid",
          status: 200,
          credentialFingerprint: geminiApiKeyFingerprint("different-key"),
        },
      },
      "validation_fingerprint_mismatch",
    ],
  ] as const)("refuses %s", async (_name, options, errorCode) => {
    enableStGeminiBootstrap();
    await seedStGeminiProvider({ ...options });
    const capture = installInfisicalMock({ st: {} });

    const result = await bootstrapStGeminiCredentialToInfisical();

    expect(result).toMatchObject({
      enabled: true,
      attempted: false,
      status: "ineligible",
      errorCode,
    });
    expect(capture.loginSources).toHaveLength(0);
    expect(capture.secretCreates).toHaveLength(0);
  });

  it("rejects extra allocation and CT/shared or unreadable bindings", async () => {
    enableStGeminiBootstrap();
    const cases = [
      {
        expected: "project_allocation_mismatch",
        prepare: async () => {
          const { provider } = await seedStGeminiProvider();
          const extra = await prisma.project.create({
            data: { name: "Congress.Trade" },
          });
          await prisma.providerProjectAllocation.create({
            data: { providerId: provider.id, projectId: extra.id, percentage: 0 },
          });
        },
      },
      {
        expected: "binding_conflict",
        prepare: async () => {
          await seedStGeminiProvider({
            secretConfig: encryptJson({
              infisicalCredential: {
                scope: "ct",
                source: "ct",
                providerName: "google-ai",
              },
            }),
          });
        },
      },
      {
        expected: "binding_unreadable",
        prepare: async () => {
          await seedStGeminiProvider({ secretConfig: "not-an-envelope" });
        },
      },
    ];

    for (const testCase of cases) {
      await prisma.provider.deleteMany();
      await prisma.project.deleteMany();
      await testCase.prepare();
      vi.unstubAllGlobals();
      const capture = installInfisicalMock({ st: {} });

      const result = await bootstrapStGeminiCredentialToInfisical();

      expect(result).toMatchObject({
        status: "ineligible",
        errorCode: testCase.expected,
      });
      expect(capture.secretCreates).toHaveLength(0);
    }
  });

  it("treats an existing equal value as a no-op and a different value as a hard conflict", async () => {
    enableStGeminiBootstrap();
    const { provider, key } = await seedStGeminiProvider();
    let capture = installInfisicalMock({ st: { GEMINI_API_KEY: key! } });

    const same = await bootstrapStGeminiCredentialToInfisical();

    expect(same).toMatchObject({
      attempted: false,
      status: "already_present_same",
    });
    expect(capture.secretCreates).toHaveLength(0);

    vi.unstubAllGlobals();
    capture = installInfisicalMock({
      st: { GEMINI_API_KEY: "different-infisical-value" },
    });
    const conflict = await bootstrapStGeminiCredentialToInfisical();

    expect(conflict).toMatchObject({
      attempted: false,
      status: "conflict",
      errorCode: "existing_value_conflict",
    });
    expect(capture.secretCreates).toHaveLength(0);
    expectRedacted(conflict, [key!, "different-infisical-value"]);

    const sync = await syncProviderCredentialsFromInfisical({
      suppressStGemini: true,
    });
    expect(sync.suppressed).toBe(1);
    const preserved = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(decrypt(preserved.apiKey!)).toBe(key);
    expect(preserved.secretConfig).toBeNull();
    expect(preserved.alertConfigGeneration).toBe(7);
  });

  it("keeps the initial ST Gemini binding guard after the bootstrap flag is disabled, then permits equal binding and bound rotation", async () => {
    enableStGeminiBootstrap();
    const { provider, key } = await seedStGeminiProvider();
    const secrets = {
      st: { GEMINI_API_KEY: "different-infisical-value" },
    };
    installInfisicalMock(secrets);

    const conflict = await bootstrapStGeminiCredentialToInfisical();
    expect(conflict).toMatchObject({
      status: "conflict",
      errorCode: "existing_value_conflict",
    });

    delete process.env.INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED;
    const conflictingPull = await syncProviderCredentialsFromInfisical();
    expect(conflictingPull.updated).toBe(0);
    expect(conflictingPull.failed).toBeGreaterThan(0);
    let stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(decrypt(stored.apiKey!)).toBe(key);
    expect(stored.secretConfig).toBeNull();
    expect(stored.alertConfigGeneration).toBe(7);

    secrets.st.GEMINI_API_KEY = key!;
    const equalPull = await syncProviderCredentialsFromInfisical();
    expect(equalPull.updated).toBe(1);
    stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(decrypt(stored.apiKey!)).toBe(key);
    expect(decryptJson(stored.secretConfig!)).toMatchObject({
      infisicalCredential: {
        scope: "st",
        source: "st",
        providerName: "google-ai",
      },
    });

    secrets.st.GEMINI_API_KEY = "rotated-after-binding";
    const rotationPull = await syncProviderCredentialsFromInfisical();
    expect(rotationPull.updated).toBe(1);
    stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(decrypt(stored.apiKey!)).toBe("rotated-after-binding");
    expect(stored.alertConfigGeneration).toBe(9);
  });

  it.each([
    ["scope preflight", { scopeStatus: { st: 403 } }, "scope_http_403"],
    [
      "exact secret read",
      { secretStatus: { st: { GEMINI_API_KEY: 403 } } },
      "secret_http_403",
    ],
  ] as const)("does not create after a failed %s", async (_name, mockOptions, errorCode) => {
    enableStGeminiBootstrap();
    await seedStGeminiProvider();
    const capture = installInfisicalMock({ st: {} }, mockOptions);

    const result = await bootstrapStGeminiCredentialToInfisical();

    expect(result).toMatchObject({
      attempted: false,
      status: "error",
      errorCode,
    });
    expect(capture.secretCreates).toHaveLength(0);
  });

  it("does not treat an inconsistent names-only preflight as a definite miss", async () => {
    enableStGeminiBootstrap();
    await seedStGeminiProvider();
    const capture = installInfisicalMock(
      { st: { GEMINI_API_KEY: "listed-value" } },
      { secretStatus: { st: { GEMINI_API_KEY: 404 } } }
    );

    const result = await bootstrapStGeminiCredentialToInfisical();

    expect(result).toMatchObject({
      attempted: false,
      status: "error",
      errorCode: "scope_inconsistent_missing_secret",
    });
    expect(capture.secretCreates).toHaveLength(0);
  });

  it("refuses a generation race immediately before create", async () => {
    enableStGeminiBootstrap();
    await seedStGeminiProvider();
    const capture = installInfisicalMock(
      { st: {} },
      {
        afterFirstMissingStGeminiRead: async () => {
          await prisma.provider.update({
            where: { id: ST_GEMINI_PROVIDER_ID },
            data: { alertConfigGeneration: { increment: 1 } },
          });
        },
      }
    );

    const result = await bootstrapStGeminiCredentialToInfisical();

    expect(result).toMatchObject({
      attempted: false,
      status: "conflict",
      errorCode: "concurrent_provider_edit",
    });
    expect(capture.secretCreates).toHaveLength(0);
  });

  it("refuses a credential-fingerprint race even without a generation change", async () => {
    enableStGeminiBootstrap();
    await seedStGeminiProvider();
    const capture = installInfisicalMock(
      { st: {} },
      {
        afterFirstMissingStGeminiRead: async () => {
          await prisma.provider.update({
            where: { id: ST_GEMINI_PROVIDER_ID },
            data: { apiKey: encrypt("rotated-without-generation") },
          });
        },
      }
    );

    const result = await bootstrapStGeminiCredentialToInfisical();

    expect(result).toMatchObject({
      attempted: false,
      status: "conflict",
      errorCode: "concurrent_provider_edit",
    });
    expect(capture.secretCreates).toHaveLength(0);
  });

  it("never retries or updates after a create conflict", async () => {
    enableStGeminiBootstrap();
    const { key } = await seedStGeminiProvider();
    const capture = installInfisicalMock(
      { st: {} },
      { createStatus: 409 }
    );

    const result = await bootstrapStGeminiCredentialToInfisical();

    expect(result).toMatchObject({
      attempted: true,
      status: "error",
      errorCode: "create_http_409",
    });
    expect(capture.secretCreates).toHaveLength(1);
    expect(
      capture.events.filter(
        (event) => event === "POST /api/v4/secrets/GEMINI_API_KEY"
      )
    ).toHaveLength(1);
    expect(capture.events.some((event) => event.startsWith("PATCH "))).toBe(false);
    expect(capture.events.some((event) => event.startsWith("DELETE "))).toBe(false);
    expectRedacted(result, [key!]);
  });

  it.each(CREATE_RESPONSE_IDENTITY_CASES)(
    "rejects a 2xx create response with %s",
    async (_caseName, field, value) => {
      enableStGeminiBootstrap();
      const { provider, key } = await seedStGeminiProvider();
      const capture = installInfisicalMock(
        { st: {} },
        { createResponseOverrides: { [field]: value } }
      );

      const result = await bootstrapStGeminiCredentialToInfisical();

      expect(result).toMatchObject({
        attempted: true,
        status: "error",
        errorCode: "create_scope_mismatch",
      });
      expect(capture.secretCreates).toHaveLength(1);
      expect(
        capture.events.filter(
          (event) => event === "GET /api/v4/secrets/GEMINI_API_KEY"
        )
      ).toHaveLength(1);
      const sameCyclePull = await syncProviderCredentialsFromInfisical({
        suppressStGemini: true,
      });
      expect(sameCyclePull.suppressed).toBe(1);
      const preserved = await prisma.provider.findUniqueOrThrow({
        where: { id: provider.id },
      });
      expect(decrypt(preserved.apiKey!)).toBe(key);
      expect(preserved.secretConfig).toBeNull();
      expectRedacted(result, [key!, SOURCE_ENV.st.clientSecret]);
      expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
        key
      );
    }
  );

  it.each(READ_RESPONSE_IDENTITY_CASES)(
    "rejects an exact post-create read with %s and suppresses the same-cycle pull",
    async (_caseName, field, value) => {
      enableStGeminiBootstrap();
      const { provider, key } = await seedStGeminiProvider();
      const capture = installInfisicalMock(
        { st: {} },
        { exactReadResponseOverrides: { [field]: value } }
      );

      const result = await bootstrapStGeminiCredentialToInfisical();

      expect(result).toMatchObject({
        attempted: true,
        status: "error",
        errorCode: "post_create_scope_mismatch",
      });
      expect(capture.secretCreates).toHaveLength(1);
      expect(
        capture.events.filter(
          (event) => event === "GET /api/v4/secrets/GEMINI_API_KEY"
        )
      ).toHaveLength(2);

      const sameCyclePull = await syncProviderCredentialsFromInfisical({
        suppressStGemini: true,
      });
      expect(sameCyclePull.suppressed).toBe(1);
      const preserved = await prisma.provider.findUniqueOrThrow({
        where: { id: provider.id },
      });
      expect(decrypt(preserved.apiKey!)).toBe(key);
      expect(preserved.secretConfig).toBeNull();
      expectRedacted(result, [key!, SOURCE_ENV.st.clientSecret]);
      expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(
        key
      );
    }
  );

  it("rejects a 2xx create whose exact post-create read has a different value", async () => {
    enableStGeminiBootstrap();
    const { provider, key } = await seedStGeminiProvider();
    const capture = installInfisicalMock(
      { st: {} },
      { postCreateReadValue: "different-post-create-value" }
    );

    const result = await bootstrapStGeminiCredentialToInfisical();

    expect(result).toMatchObject({
      attempted: true,
      status: "error",
      errorCode: "post_create_value_mismatch",
    });
    expect(capture.secretCreates).toHaveLength(1);
    expect(
      capture.events.filter(
        (event) => event === "GET /api/v4/secrets/GEMINI_API_KEY"
      )
    ).toHaveLength(2);

    const sameCyclePull = await syncProviderCredentialsFromInfisical({
      suppressStGemini: true,
    });
    expect(sameCyclePull.suppressed).toBe(1);
    const preserved = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
    });
    expect(decrypt(preserved.apiKey!)).toBe(key);
    expect(preserved.secretConfig).toBeNull();
    expectRedacted(result, [key!, "different-post-create-value"]);
  });

  it("bounds and cancels an oversized create response without exposing the key", async () => {
    enableStGeminiBootstrap();
    const { key } = await seedStGeminiProvider();
    const capture = installInfisicalMock(
      { st: {} },
      { oversizedCreate: true }
    );

    const result = await bootstrapStGeminiCredentialToInfisical();

    expect(result).toMatchObject({
      attempted: true,
      status: "error",
      errorCode: "response_too_large",
    });
    expect(capture.oversizedCreateBodyCanceled).toBe(true);
    expectRedacted(result, [key!, SOURCE_ENV.st.clientSecret]);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(key);
  });
});
