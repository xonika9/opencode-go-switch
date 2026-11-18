import { describe, expect, test } from "bun:test";
import { DEFAULT_USAGE_URL, fetchUsage, MAX_USAGE_BYTES, parseUsage, retryAfterMs } from "../src/usage.ts";
import type { FetchLike, UsageCredential, UsageResult } from "../src/usage.ts";

const KEY = "key-a";

const validPayload = {
  usage: {
    rolling: { status: "ok", percent: 32.5, resetsAt: "2026-11-18T15:00:00.000Z" },
    weekly: { status: "ok", percent: 44, resetsAt: "2026-11-22T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-12-01T00:00:00.000Z" },
  },
  extra: { ignored: true },
};

const options = (
  fetch: FetchLike,
  overrides: { timeoutMs?: number; maxBytes?: number; url?: string } = {},
) => ({
  fetch,
  url: overrides.url ?? DEFAULT_USAGE_URL,
  timeoutMs: overrides.timeoutMs ?? 1_000,
  maxBytes: overrides.maxBytes,
});

interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fake fetch that records every call, so tests can prove a request was never sent. */
function recorder(respond: () => Response | Promise<Response>): {
  calls: Recorded[];
  fetch: FetchLike;
} {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond();
    },
  };
}

const okBody = () => new Response(JSON.stringify(validPayload), { status: 200 });

const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  (init?.headers ?? {}) as Record<string, string>;

describe("parseUsage", () => {
  test("reads all three windows and ignores unknown fields", () => {
    expect(parseUsage(validPayload)).toEqual({
      rolling: { percent: 32.5, limited: false, resetsAt: Date.parse("2026-11-18T15:00:00.000Z") },
      weekly: { percent: 44, limited: false, resetsAt: Date.parse("2026-11-22T00:00:00.000Z") },
      monthly: { percent: 100, limited: true, resetsAt: Date.parse("2026-12-01T00:00:00.000Z") },
    });
  });

  test("accepts an epoch-millisecond reset time and reads it like the ISO form", () => {
    const rolling = Date.parse("2026-11-18T15:00:00.000Z");
    const weekly = Date.parse("2026-11-22T00:00:00.000Z");
    const monthly = Date.parse("2026-12-01T00:00:00.000Z");
    const parsed = parseUsage({
      usage: {
        rolling: { status: "ok", percent: 32.5, resetsAt: rolling },
        weekly: { status: "ok", percent: 44, resetsAt: weekly },
        monthly: { status: "rate-limited", percent: 100, resetsAt: monthly },
      },
    });
    expect(parsed).toEqual(parseUsage(validPayload));
  });

  test("keeps a window with an unusable reset time, without a reset time", () => {
    const parsed = parseUsage({
      usage: {
        rolling: { status: "ok", percent: 1 },
        weekly: { status: "ok", percent: 2, resetsAt: "not a date" },
        monthly: { status: "rate-limited", percent: 100, resetsAt: Number.NaN },
      },
    });
    expect(parsed?.rolling.resetsAt).toBeNull();
    expect(parsed?.weekly.resetsAt).toBeNull();
    expect(parsed?.monthly.limited).toBe(true);
    expect(parsed?.monthly.resetsAt).toBeNull();
  });

  test("a rate-limited status is limited even below 100 percent", () => {
    const parsed = parseUsage({
      usage: {
        rolling: { status: "rate-limited", percent: 40 },
        weekly: { status: "ok", percent: 99.9 },
        monthly: { status: "ok", percent: 100 },
      },
    });
    expect(parsed?.rolling.limited).toBe(true);
    expect(parsed?.weekly.limited).toBe(false);
    expect(parsed?.monthly.limited).toBe(true);
  });

  test("treats out-of-range percentages as exhausted rather than rejecting the payload", () => {
    const parsed = parseUsage({
      usage: {
        rolling: { status: "ok", percent: 0 },
        weekly: { status: "ok", percent: 0 },
        monthly: { status: "ok", percent: 140, resetsAt: "2026-12-01T00:00:00Z" },
      },
    });
    expect(parsed?.monthly.limited).toBe(true);
  });

  test("rejects malformed and incomplete payloads", () => {
    const bad: unknown[] = [
      null,
      [],
      {},
      { usage: null },
      { usage: [] },
      { usage: { rolling: { status: "ok", percent: 1 } } },
      {
        usage: {
          rolling: { status: "ok", percent: "10" },
          weekly: { status: "ok", percent: 1 },
          monthly: { status: "ok", percent: 1 },
        },
      },
      {
        usage: {
          rolling: { status: "weird", percent: 1 },
          weekly: { status: "ok", percent: 1 },
          monthly: { status: "ok", percent: 1 },
        },
      },
      {
        usage: {
          rolling: { status: "ok", percent: -5 },
          weekly: { status: "ok", percent: 1 },
          monthly: { status: "ok", percent: 1 },
        },
      },
      {
        usage: {
          rolling: { status: "ok", percent: 1 },
          weekly: { status: "ok", percent: 1 },
          monthly: { status: "ok" },
        },
      },
    ];
    for (const payload of bad) expect(parseUsage(payload)).toBeNull();
  });
});

describe("fetchUsage", () => {
  test("returns parsed usage from a good response", async () => {
    const result = await fetchUsage({ key: KEY }, options(async () => okBody()));
    expect(result.type).toBe("usage");
    if (result.type !== "usage") throw new Error("unreachable");
    expect(result.usage.monthly.limited).toBe(true);
    expect(result.usage.rolling.resetsAt).toBe(Date.parse("2026-11-18T15:00:00.000Z"));
  });

  test("sends the key as a bearer token, with no org header and no redirects", async () => {
    const fake = recorder(okBody);
    await fetchUsage({ key: KEY }, options(fake.fetch));
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    if (call === undefined) throw new Error("unreachable");
    const headers = headersOf(call.init);
    expect(call.url).toBe(DEFAULT_USAGE_URL);
    expect(call.init?.method).toBe("GET");
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers.accept).toBe("application/json");
    expect(headers["x-opencode-org-id"]).toBeUndefined();
    expect(call.init?.redirect).toBe("manual");
    expect(call.init?.signal).toBeDefined();
  });

  test("a https server in the credential metadata decides the URL, and orgID is sent", async () => {
    const fake = recorder(okBody);
    const credential: UsageCredential = {
      key: KEY,
      metadata: { server: "https://go.example.com/some/path", orgID: "org-42", other: 1 },
    };
    const result = await fetchUsage(credential, options(fake.fetch));
    expect(result.type).toBe("usage");
    const call = fake.calls[0];
    if (call === undefined) throw new Error("unreachable");
    expect(call.url).toBe("https://go.example.com/zen/go/v1/usage");
    expect(headersOf(call.init)["x-opencode-org-id"]).toBe("org-42");
  });

  test("metadata without a server keeps the configured URL and sends no org header", async () => {
    const fake = recorder(okBody);
    await fetchUsage({ key: KEY, metadata: { other: "value" } }, options(fake.fetch));
    const call = fake.calls[0];
    if (call === undefined) throw new Error("unreachable");
    expect(call.url).toBe(DEFAULT_USAGE_URL);
    expect(headersOf(call.init)["x-opencode-org-id"]).toBeUndefined();
  });

  test("a plain http server or usage URL is unknown, and the key never leaves", async () => {
    const insecureServer = recorder(okBody);
    const serverResult = await fetchUsage(
      { key: KEY, metadata: { server: "http://go.example.com" } },
      options(insecureServer.fetch),
    );
    expect(serverResult.type).toBe("unavailable");
    expect(insecureServer.calls).toHaveLength(0);

    const insecureUrl = recorder(okBody);
    const urlResult = await fetchUsage(
      { key: KEY },
      options(insecureUrl.fetch, { url: "http://opencode.ai/zen/go/v1/usage" }),
    );
    expect(urlResult.type).toBe("unavailable");
    expect(insecureUrl.calls).toHaveLength(0);
  });

  test("a server that does not parse is unknown, and no request is sent", async () => {
    const fake = recorder(okBody);
    const result = await fetchUsage(
      { key: KEY, metadata: { server: "not a url" } },
      options(fake.fetch),
    );
    expect(result.type).toBe("unavailable");
    expect(fake.calls).toHaveLength(0);
  });

  test("a redirect is never followed and counts as unknown", async () => {
    const fake = recorder(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }),
    );
    const result = await fetchUsage({ key: KEY }, options(fake.fetch));
    expect(result.type).toBe("unavailable");
    expect(fake.calls).toHaveLength(1);
  });

  test("malformed JSON, a missing window, and a non-numeric percent are unknown", async () => {
    const bodies = [
      "{oops",
      '{"usage":{}}',
      JSON.stringify({
        usage: {
          rolling: { status: "ok", percent: 1 },
          weekly: { status: "ok", percent: "2" },
          monthly: { status: "ok", percent: 3 },
        },
      }),
    ];
    for (const body of bodies) {
      const result = await fetchUsage({ key: KEY }, options(async () => new Response(body, { status: 200 })));
      expect(result.type).toBe("unavailable");
    }
  });

  test("401 is an invalid key, while 403 and other errors are unknown", async () => {
    const statuses: Array<[number, UsageResult["type"]]> = [
      [401, "invalid-key"],
      [403, "unavailable"],
      [500, "unavailable"],
    ];
    for (const [status, type] of statuses) {
      const result = await fetchUsage({ key: KEY }, options(async () => new Response("no", { status })));
      expect(result.type).toBe(type);
    }
  });

  test("the body cap is enforced while streaming, without Content-Length", async () => {
    const body = new TextEncoder().encode(JSON.stringify(validPayload).padEnd(400, " "));
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < body.byteLength; offset += 40) chunks.push(body.slice(offset, offset + 40));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[sent];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const result = await fetchUsage(
      { key: KEY },
      options(() => Promise.resolve(new Response(stream, { status: 200 })), { maxBytes: 100 }),
    );
    expect(result.type).toBe("unavailable");
    expect(sent).toBeLessThan(chunks.length);
  });

  test("a declared Content-Length above the cap short-circuits", async () => {
    const response = new Response(JSON.stringify(validPayload), {
      status: 200,
      headers: { "content-length": String(MAX_USAGE_BYTES + 1) },
    });
    expect((await fetchUsage({ key: KEY }, options(async () => response))).type).toBe("unavailable");
  });

  test("a request that never answers times out as unavailable", async () => {
    const slow: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const started = Date.now();
    const result = await fetchUsage({ key: KEY }, options(slow, { timeoutMs: 20 }));
    expect(result.type).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a thrown error is unknown and never carries the key", async () => {
    const result = await fetchUsage(
      { key: KEY },
      options(async () => {
        throw new Error(`request failed for ${KEY}`);
      }),
    );
    expect(result.type).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("retryAfterMs", () => {
  test("accepts delay-seconds and HTTP dates", () => {
    expect(retryAfterMs("60", 0)).toBe(60_000);
    expect(retryAfterMs("Thu, 01 Jan 2026 00:01:00 GMT", Date.parse("2026-01-01T00:00:00Z"))).toBe(60_000);
  });

  test("ignores missing or unparsable values", () => {
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs("", 0)).toBeNull();
    expect(retryAfterMs("soon", 0)).toBeNull();
  });
});
