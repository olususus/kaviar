export interface KaviarOptions<T> {
  ttl?: number;
  swr?: number;
  ctx?: { waitUntil: (promise: Promise<any>) => void };
  tags?: string[];
  compress?: boolean;
  encrypt?: { key: string };
  schema?: { parse: (data: any) => T };
  onRevalidateError?: (error: unknown) => void;
}

interface CachedValue<T> {
  data: any;
  exceedsSwrAt: number;
  compressed?: boolean;
  encrypted?: boolean;
}

const B64_CHUNK = 0x8000;

const aesKeyCache = new Map<string, Promise<CryptoKey>>();

function getAesKey(secret: string): Promise<CryptoKey> {
  let p = aesKeyCache.get(secret);
  if (!p) {
    const enc = new TextEncoder();
    p = crypto.subtle.importKey(
      "raw",
      enc.encode(secret.padEnd(32).slice(0, 32)),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    aesKeyCache.set(secret, p);
  }
  return p;
}

export async function hashKey(key: unknown): Promise<string> {
  const str = typeof key === "string" ? key : JSON.stringify(key);
  const msgUint8 = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const bytes = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function gzipUtf8String(plain: string): Promise<string> {
  const enc = new TextEncoder();
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(enc.encode(plain));
  await writer.close();
  const buf = await new Response(stream.readable).arrayBuffer();
  return bytesToBase64(new Uint8Array(buf));
}

async function gunzipToUtf8String(b64: string): Promise<string> {
  const raw = base64ToBytes(b64);
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  await writer.write(raw);
  await writer.close();
  const buf = await new Response(stream.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

async function encryptData(data: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await getAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(data)
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64(combined);
}

async function decryptData(encryptedB64: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const data = base64ToBytes(encryptedB64);
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const key = await getAesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );
  return dec.decode(decrypted);
}

export async function kaviar<T>(
  kv: KVNamespace | undefined,
  key: any,
  fetcher: () => Promise<T>,
  options: KaviarOptions<T> = {}
): Promise<T> {
  const { ctx, swr = 0, schema } = options;

  if (!kv || typeof kv.get !== "function") {
    return fetcher();
  }

  const hashedKey = await hashKey(key);
  const cached = await kv.get<CachedValue<T>>(hashedKey, "json");

  if (cached) {
    let rawData: string | object = cached.data;

    if (cached.encrypted) {
      if (!options.encrypt) {
        throw new Error(
          "kaviar: cache entry is encrypted but options.encrypt was not provided"
        );
      }
      rawData = await decryptData(rawData as string, options.encrypt.key);
    }

    if (cached.compressed) {
      rawData = await gunzipToUtf8String(rawData as string);
    }

    const finalData =
      typeof rawData === "string" ? JSON.parse(rawData) : rawData;

    if (swr > 0 && Date.now() > cached.exceedsSwrAt) {
      if (ctx?.waitUntil) {
        ctx.waitUntil(
          (async () => {
            try {
              const fresh = await fetcher();
              await storeInKv(kv, hashedKey, fresh, options);
            } catch (e) {
              options.onRevalidateError?.(e);
            }
          })()
        );
      }
    }

    if (schema) return schema.parse(finalData);
    return finalData as T;
  }

  const freshData = await fetcher();
  await storeInKv(kv, hashedKey, freshData, options);
  return freshData;
}

async function storeInKv<T>(
  kv: KVNamespace,
  hashedKey: string,
  data: T,
  options: KaviarOptions<T>
) {
  const { ttl = 60, swr = 0, tags, encrypt, compress } = options;
  const exceedsSwrAt = Date.now() + ttl * 1000;
  const kvTtl = Math.max(60, ttl + swr);
  const tagIndexTtl = Math.max(86400 * 14, kvTtl);

  let body: string = JSON.stringify(data);
  let isCompressed = false;

  if (compress) {
    body = await gzipUtf8String(body);
    isCompressed = true;
  }

  let isEncrypted = false;
  if (encrypt) {
    body = await encryptData(body, encrypt.key);
    isEncrypted = true;
  }

  const payload: CachedValue<T> = {
    data: body,
    exceedsSwrAt,
    compressed: isCompressed,
    encrypted: isEncrypted,
  };

  await kv.put(hashedKey, JSON.stringify(payload), {
    expirationTtl: kvTtl,
  });

  if (tags && tags.length > 0) {
    const tagReads = await Promise.all(
      tags.map(async (tag) => {
        const tagKey = `_kaviar_t:${tag}`;
        const existing = (await kv.get<string[]>(tagKey, "json")) || [];
        return { tagKey, existing };
      })
    );

    await Promise.all(
      tagReads.map(({ tagKey, existing }) => {
        if (!existing.includes(hashedKey)) {
          existing.push(hashedKey);
        }
        return kv.put(tagKey, JSON.stringify(existing), {
          expirationTtl: tagIndexTtl,
        });
      })
    );
  }
}

export async function invalidate(kv: KVNamespace, tag: string) {
  const tagKey = `_kaviar_t:${tag}`;
  const keys = await kv.get<string[]>(tagKey, "json");
  if (!keys?.length) {
    if (keys) await kv.delete(tagKey);
    return;
  }
  await Promise.all(keys.map((key) => kv.delete(key)));
  await kv.delete(tagKey);
}
