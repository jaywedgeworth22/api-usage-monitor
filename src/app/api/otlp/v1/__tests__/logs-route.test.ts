import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";

// Logs route is an accept-and-drop stub (see route.ts's docblock for why:
// this app's schema has no per-event log concept, and errors/health live in
// Sentry per the owner's goal split). These tests confirm the documented
// contract: authenticated, decodes real OTLP logs payloads, never persists,
// never 500s on well-formed input.

let POST: typeof import("../logs/route").POST;

beforeAll(async () => {
  process.env.USAGE_INGEST_TOKEN = "test-token-123";
  ({ POST } = await import("../logs/route"));
});

function jsonRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://usage.jays.services/api/otlp/v1/logs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const samplePayload = {
  resourceLogs: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] },
      scopeLogs: [
        {
          scope: { name: "com.anthropic.claude_code" },
          logRecords: [
            { timeUnixNano: "1751500060000000000", severityText: "INFO", body: { stringValue: "hi" } },
            { timeUnixNano: "1751500060000000001", severityText: "INFO", body: { stringValue: "bye" } },
          ],
        },
      ],
    },
  ],
};

describe("POST /api/otlp/v1/logs", () => {
  it("rejects requests with no auth header", async () => {
    const res = await POST(jsonRequest(samplePayload));
    expect(res.status).toBe(401);
  });

  it("accepts a valid bearer token, decodes, and reports stored: false", async () => {
    const res = await POST(jsonRequest(samplePayload, { authorization: "Bearer test-token-123" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stored).toBe(false);
    expect(body.accepted).toBe(0);
    expect(body.received).toBe(2);
  });

  it("never 500s on a well-formed but empty payload", async () => {
    const res = await POST(jsonRequest({}, { authorization: "Bearer test-token-123" }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.received).toBe(0);
  });

  it("rejects malformed JSON shape with 400, not 500", async () => {
    const res = await POST(jsonRequest({ resourceLogs: "not-an-array" }, { authorization: "Bearer test-token-123" }));
    expect(res.status).toBe(400);
  });
});
