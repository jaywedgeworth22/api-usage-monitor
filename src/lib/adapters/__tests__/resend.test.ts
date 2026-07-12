import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../resend";

describe("resend adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces provider rate-limit headers without calling a sending endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "key-1" }] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "ratelimit-limit": "100",
          "ratelimit-remaining": "73",
          "ratelimit-reset": "1s",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("key");

    expect(result.externalBilling?.records[0]).toMatchObject({
      serviceName: "Resend API",
      requestLimit: 100,
      usageQuantity: 27,
      remainingQuantity: 73,
      rollupRole: "metadata",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.resend.com/api-keys");
  });
});
