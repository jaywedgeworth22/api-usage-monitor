import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage, isAllowedPineconeIndexHost, pineconeHeaders } from "../pinecone";

describe("Pinecone discovered-host security", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("allows only Pinecone-controlled service hosts", () => {
    expect(isAllowedPineconeIndexHost("idx-project.svc.us-east-1-aws.pinecone.io")).toBe(true);
    expect(isAllowedPineconeIndexHost("idx-project.svc.aped-1234.pinecone.io")).toBe(true);
    expect(isAllowedPineconeIndexHost("pinecone.io.attacker.example")).toBe(false);
    expect(isAllowedPineconeIndexHost("127.0.0.1")).toBe(false);
  });

  it("uses the required API version on control-plane and data-plane requests", () => {
    expect(pineconeHeaders("secret-key")).toMatchObject({
      "Api-Key": "secret-key",
      "X-Pinecone-Api-Version": "2026-04",
    });
  });

  it("does not forward the API key to an untrusted discovered host", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ indexes: [{ name: "bad", host: "metadata.google.internal" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("secret-key");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "Api-Key": "secret-key",
      "X-Pinecone-Api-Version": "2026-04",
    });
    expect(JSON.stringify(result.rawData)).toContain("outside the allowed");
    expect(result.externalBilling?.records[0]).toMatchObject({
      serviceName: "bad",
      rollupRole: "metadata",
    });
  });
});
