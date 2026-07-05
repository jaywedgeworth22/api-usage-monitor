import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resilientFetch } from "../adapters/helpers";

describe("resilientFetch", () => {
  let fetchMock: any;

  beforeEach(() => {
    fetchMock = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("performs a successful fetch on the first try", async () => {
    const mockResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    fetchMock.mockResolvedValueOnce(mockResponse);

    const res = await resilientFetch("https://api.example.com/test", {}, 2000);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 status code and succeeds on subsequent try", async () => {
    const rateLimitResponse = new Response(null, {
      status: 429,
      headers: { "retry-after": "1" },
    });
    const successResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    fetchMock.mockResolvedValueOnce(rateLimitResponse).mockResolvedValueOnce(successResponse);

    const res = await resilientFetch("https://api.example.com/test", {}, 2000);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 500 status code and fails after 3 attempts", async () => {
    const errorResponse = new Response(null, { status: 500 });
    fetchMock.mockResolvedValue(errorResponse);

    const res = await resilientFetch("https://api.example.com/test", {}, 2000);
    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on timeout (AbortError) and succeeds on subsequent try", async () => {
    // First call triggers a mock timeout
    fetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
      // Simulate timeout by throwing AbortError when signal is aborted
      if (init?.signal) {
        if (init.signal.aborted) {
          throw new DOMException("The user aborted a request.", "AbortError");
        }
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(new DOMException("The user aborted a request.", "AbortError"));
          init.signal!.addEventListener("abort", onAbort);
        });
      }
      throw new Error("Should be aborted");
    });

    const successResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    fetchMock.mockResolvedValueOnce(successResponse);

    // Set timeout to 50ms to execute fast
    const res = await resilientFetch("https://api.example.com/test", {}, 50);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on timeout (AbortError) if it keeps timing out", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.signal) {
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(new DOMException("The user aborted a request.", "AbortError"));
          if (init.signal!.aborted) {
            onAbort();
          } else {
            init.signal!.addEventListener("abort", onAbort);
          }
        });
      }
      throw new Error("Should be aborted");
    });

    await expect(resilientFetch("https://api.example.com/test", {}, 10)).rejects.toThrow("Request timed out");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
