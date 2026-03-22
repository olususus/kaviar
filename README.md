# kaviar

[![npm version](https://img.shields.io/npm/v/@sprawdzany/kaviar)](https://www.npmjs.com/package/@sprawdzany/kaviar)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Small **Cloudflare KV** cache helper for Workers and Pages Functions: TTL, optional **stale-while-revalidate (SWR)**, optional **gzip**, optional **AES-GCM** encryption, **tag invalidation**, and optional **schema validation** (e.g. Zod).

Open source under the **MIT** license. Install from **npm**; source is whatever Git host you use.

**Deep dive** (payload format, TTL/SWR timeline, security, tags): **[how.md](./how.md)**.

## When to use it

- Cache expensive upstream calls (APIs, origins) in KV with a simple API.
- Serve fast responses while **refreshing in the background** after the fresh window (`SWR` + `ctx.waitUntil`).
- **Invalidate groups** of keys (e.g. `user:123`) via tags.
- Optional **compression** for large JSON; optional **encryption** for sensitive blobs at rest in KV.

Not an HTTP cache (no `Cache-Control` / Cache API). Not a general database; use KV for what KV is good at.

## Install

```bash
npm install @sprawdzany/kaviar
```

Optional peer: `zod` (only if you use `schema` with Zod).

## Development

From the package directory (after cloning from your Git host):

```bash
npm install
npm test
npm run build
```

Requires **Node 20+** for tests (Web Crypto + Compression Streams).

## Bind KV in Wrangler

Add a namespace and wire it to your Worker:

```toml
[[kv_namespaces]]
binding = "MY_CACHE"
id = "<your-kv-namespace-id>"
```

```typescript
interface Env {
  MY_CACHE: KVNamespace;
}
```

```typescript
import { kaviar } from "@sprawdzany/kaviar";

export default {
  async fetch(request, env, ctx) {
    const data = await kaviar(
      env.MY_CACHE,
      ["profile", userId],
      async () => fetchUpstreamJson(userId),
      { ttl: 120, swr: 600, ctx }
    );
    return Response.json(data);
  },
};
```

## Features (quick reference)

| Feature | What it does |
|--------|----------------|
| TTL | Fresh window for SWR (`exceedsSwrAt`). |
| SWR | After fresh, serve stale while refreshing in background if `ctx.waitUntil` is set. |
| `compress` | Gzip JSON before optional encryption (saves KV space). |
| `encrypt` | AES-GCM; same `key` required on read. |
| `tags` + `invalidate` | Bulk delete by tag. |
| `schema` | `parse()` after JSON (e.g. Zod). |
| `onRevalidateError` | SWR failures (not swallowed). |
| Missing `kv` | Skips cache; always runs fetcher (useful for local dev without a binding). |

## Examples

### Tags

```typescript
import { kaviar, invalidate } from "@sprawdzany/kaviar";

await kaviar(env.KV, ["user", id], fetchUser, { tags: [`user:${id}`, "users"] });
await invalidate(env.KV, `user:${id}`);
```

### Compression + encryption

Order is always **JSON → gzip → encrypt** (see [how.md](./how.md)).

```typescript
await kaviar(env.KV, "big", fetchBig, {
  ttl: 300,
  compress: true,
  encrypt: { key: env.SECRET_KEY },
});
```

### Zod

```typescript
import { z } from "zod";

const UserSchema = z.object({ id: z.number(), name: z.string() });

const data = await kaviar(env.KV, "profile", fetchProfile, {
  schema: UserSchema,
});
```

### SWR errors

```typescript
await kaviar(env.KV, key, fetcher, {
  ttl: 60,
  swr: 120,
  ctx,
  onRevalidateError: (err) => console.error("SWR failed", err),
});
```

## API

- **`kaviar(kv, key, fetcher, options?)`** — `key` can be a string or JSON-serializable value (hashed with SHA-256).
- **`invalidate(kv, tag)`** — deletes all keys registered under `tag`.
- **`hashKey(key)`** — same hex string as the internal KV key (debugging).

Options: `ttl`, `swr`, `ctx`, `tags`, `compress`, `encrypt`, `schema`, `onRevalidateError`.

## Publish to npm

Scoped package `@sprawdzany/kaviar`.

1. Bump **`version`** in `package.json` (or `npm version patch|minor|major`).
2. **`npm run build`** and **`npm test`** (also run automatically via `prepublishOnly` on publish).
3. **`npm login`** to [npmjs.com](https://www.npmjs.com/) (once per machine).
4. **`npm publish --access public`** (first publish for a scoped public package; later often just **`npm publish`**).
5. Confirm on [npmjs.com/package/@sprawdzany/kaviar](https://www.npmjs.com/package/@sprawdzany/kaviar).

With **2FA**, you may need **`npm publish --otp=<code>`** or an **automation token** in CI.

### CI (optional)

Use a GitHub Actions workflow with an **`npm_token`** secret, or your provider’s equivalent, and `npm publish` against `https://registry.npmjs.org/`.

## Contributing

Contributions welcome. Run **`npm test`** before opening a pull request.

## License

[MIT](./LICENSE)
