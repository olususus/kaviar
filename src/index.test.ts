import { describe, it, expect, vi, beforeEach } from "vitest";
import { kaviar, invalidate, hashKey } from "./index";

class MemoryKV {
  private store = new Map<string, { value: string; expiration?: number }>();

  async get(
    key: string,
    type?: "text" | "json" | "arrayBuffer" | "stream"
  ): Promise<any> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiration !== undefined && Date.now() > e.expiration) {
      this.store.delete(key);
      return null;
    }
    if (type === "json") return JSON.parse(e.value);
    return e.value;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ReadableStream,
    options?: { expirationTtl?: number }
  ): Promise<void> {
    const str = typeof value === "string" ? value : "";
    const ttl = options?.expirationTtl;
    const expiration =
      ttl !== undefined ? Date.now() + ttl * 1000 : undefined;
    this.store.set(key, { value: str, expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe("hashKey", () => {
  it("is stable for the same logical key", async () => {
    expect(await hashKey("a")).toBe(await hashKey("a"));
    expect(await hashKey({ x: 1 })).toBe(await hashKey({ x: 1 }));
  });

  it("differs for different keys", async () => {
    expect(await hashKey("a")).not.toBe(await hashKey("b"));
  });
});

describe("kaviar", () => {
  let kv: MemoryKV;

  beforeEach(() => {
    kv = new MemoryKV();
  });

  it("bypasses cache when kv is undefined", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    const r = await kaviar(undefined, "k", fetcher);
    expect(r).toEqual({ n: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await kaviar(undefined, "k", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("caches miss then hit", async () => {
    const fetcher = vi.fn().mockResolvedValue({ id: 42 });
    const a = await kaviar(kv as unknown as KVNamespace, "user:1", fetcher, {
      ttl: 60,
    });
    const b = await kaviar(kv as unknown as KVNamespace, "user:1", fetcher, {
      ttl: 60,
    });
    expect(a).toEqual({ id: 42 });
    expect(b).toEqual({ id: 42 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses compress + decompress round-trip", async () => {
    const payload = { text: "hello".repeat(100) };
    const fetcher = vi.fn().mockResolvedValue(payload);
    const out = await kaviar(kv as unknown as KVNamespace, "c1", fetcher, {
      ttl: 60,
      compress: true,
    });
    const out2 = await kaviar(kv as unknown as KVNamespace, "c1", fetcher, {
      ttl: 60,
      compress: true,
    });
    expect(out).toEqual(payload);
    expect(out2).toEqual(payload);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("encrypts when encrypt is set", async () => {
    const secret = "x".repeat(32);
    const fetcher = vi.fn().mockResolvedValue({ secret: true });
    await kaviar(kv as unknown as KVNamespace, "e1", fetcher, {
      ttl: 60,
      encrypt: { key: secret },
    });
    const raw = await kv.get(await hashKey("e1"), "text");
    expect(typeof raw).toBe("string");
    expect(raw).not.toContain("secret");
    const again = await kaviar(kv as unknown as KVNamespace, "e1", fetcher, {
      ttl: 60,
      encrypt: { key: secret },
    });
    expect(again).toEqual({ secret: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("schedules SWR via waitUntil when stale", async () => {
    const waitUntil = vi.fn((p: Promise<unknown>) => p);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ v: 1 })
      .mockResolvedValue({ v: 2 });

    const key = "swr-key";
    const hashed = await hashKey(key);
    await kaviar(kv as unknown as KVNamespace, key, fetcher, {
      ttl: 1,
      swr: 60,
      ctx: { waitUntil },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const raw = await kv.get(hashed, "json") as {
      exceedsSwrAt: number;
      data: unknown;
    };
    raw.exceedsSwrAt = Date.now() - 1;
    await kv.put(hashed, JSON.stringify(raw));

    const out = await kaviar(kv as unknown as KVNamespace, key, fetcher, {
      ttl: 1,
      swr: 60,
      ctx: { waitUntil },
    });
    expect(out).toEqual({ v: 1 });
    expect(waitUntil).toHaveBeenCalled();
    await waitUntil.mock.results[0].value;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("calls onRevalidateError when SWR fetch fails", async () => {
    const waitUntil = vi.fn((p: Promise<unknown>) => p);
    const onRevalidateError = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValue(new Error("boom"));

    const key = "err-key";
    const hashed = await hashKey(key);
    await kaviar(kv as unknown as KVNamespace, key, fetcher, {
      ttl: 1,
      swr: 60,
      ctx: { waitUntil },
      onRevalidateError,
    });

    const raw = (await kv.get(hashed, "json")) as {
      exceedsSwrAt: number;
    };
    raw.exceedsSwrAt = Date.now() - 1;
    await kv.put(hashed, JSON.stringify(raw));

    await kaviar(kv as unknown as KVNamespace, key, fetcher, {
      ttl: 1,
      swr: 60,
      ctx: { waitUntil },
      onRevalidateError,
    });

    await waitUntil.mock.results[0].value;
    expect(onRevalidateError).toHaveBeenCalled();
    expect(onRevalidateError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe("invalidate", () => {
  it("deletes all keys listed under a tag", async () => {
    const kv = new MemoryKV();
    const fetcher = vi.fn().mockResolvedValue({ x: 1 });

    await kaviar(kv as unknown as KVNamespace, "a", fetcher, {
      ttl: 60,
      tags: ["t1"],
    });
    await kaviar(kv as unknown as KVNamespace, "b", fetcher, {
      ttl: 60,
      tags: ["t1"],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await invalidate(kv as unknown as KVNamespace, "t1");

    const h1 = await hashKey("a");
    const h2 = await hashKey("b");
    expect(await kv.get(h1, "json")).toBeNull();
    expect(await kv.get(h2, "json")).toBeNull();
    expect(await kv.get("_kaviar_t:t1", "json")).toBeNull();
  });
});
