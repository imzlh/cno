# Bun Compatibility

This directory implements cno's incremental Bun compatibility layer. It uses
the existing Web, Deno, Node, and native runtime primitives; it does not embed
Bun or JavaScriptCore. Upstream `@types/bun` is the typing target, not a claim
that every declared API exists at runtime.

## Current Surface

| Surface | Status | Notes |
| --- | --- | --- |
| `globalThis.Bun`, `bun` | Partial | One shared namespace for lifecycle, file, HTTP, process and the helpers listed below; not the full Bun namespace |
| `Bun.fetch` | Partial | Reuses cno's global Web fetch; unsupported Bun-specific options are rejected when set, while primitive `init` values follow Bun's no-options behavior. |
| `Bun.isMainThread` | Supported | Reports whether the current runtime is a worker. |
| `Bun.isStandaloneExecutable`, `Bun.embeddedFiles` | Supported | cno does not produce Bun `--compile` executables, so these feature-detection values are permanently `false` and a frozen empty list. |
| `Bun.file`, `Bun.write` | Partial | Local paths, file URL objects and UTF-8 byte paths, lazy file blobs, slices, reads, stats, deletion, and instance writes. Invalid UTF-8 byte paths are rejected because the string-based host filesystem API cannot represent them safely. `Bun.write` accepts strings, bytes, Blob, Response, Request and ReadableStream bodies; `BunFile.write` also accepts Request and ReadableStream. File-descriptor destinations, remote/S3 files, mmap, and optimized sendfile are unsupported. Path-based FileSink/`writer()` and the fixed stdio handles are covered below. |
| `Bun.dns` | Partial | `lookup` and resolver flag constants use asynchronous system getaddrinfo with TTL 0. The `libc`, `c-ares`, `system`, and `getaddrinfo` backend names all fall back to that system resolver; UDP socket type and port do not affect resolution. Prefetch and shared connection cache statistics are unsupported. |
| `Bun.serve` | Partial | HTTP over `Deno.serve` with `fetch`, `error`, `routes`, `port` and `hostname`; routes support handlers, static Response values, BunFile values, directory values (`{ dir }` on `/*` keys), `:param` and trailing `/*` patterns, method maps and fallback. Matching prefers exact paths, then parameter patterns, then wildcards; among parameter and wildcard patterns, more static segments win and registration order breaks ties (upstream's finer ordering is not pinned by an accessible oracle yet). Route-dispatched handlers receive a non-enumerable `params` property (captured `:name` segments, percent-decoded once; empty for exact and wildcard routes). `server.reload()` replaces handlers/route tables without rebinding. Static bodies are buffered once at registration, up to 16 MiB and 16,384 chunks each, with a 32 MiB aggregate cached-backing-store budget across overlapping tables; dynamic patterns are capped at 1024 per table. A stream whose size is not known up front can fail asynchronously during snapshotting. BunFile routes snapshot the file at registration and 404 for files missing then. Directory routes stream per request, reject non-canonical remainders, redirect directory requests to the trailing-slash URL, serve `index.html` for trailing-slash directories, and reject symlink escapes instead of clamping them. File responses honor conditional GET (If-None-Match / If-Modified-Since → 304) and single byte ranges (multi-range lists and non-byte units fall back to the full body, unsatisfiable ranges → 416). No TLS, WebSocket, automatic hot reload, or forceful stop. |
| `Bun.spawn`, `Bun.spawnSync` | Partial | Native subprocess adapter with stdio and exit handling; IPC, cgroups and terminals are unsupported. Sync also rejects `signal`, `timeout`, `maxBuffer`, and `argv0`; async per-child `resourceUsage` is unavailable. |
| `bun:sqlite` | Partial | Database and Statement queries, bindings, transactions, caching, and close semantics; `Statement.raw` and `columnTypes` are unsupported. |
| `Bun.gzipSync`, `gunzipSync`, `deflateSync`, `inflateSync` | Partial | One-shot gzip and raw-DEFLATE helpers over the native zlib binding; zstd is not implemented. |
| `Bun.CryptoHasher` | Partial | Incremental hashes and supported HMAC algorithms; `blake2b256` and `blake2b512` use Bun's keyed-BLAKE2b semantics for the second constructor argument (pure JavaScript), and `md4` uses a pure JavaScript implementation. |
| `BunFile.writer()` (FileSink) | Partial | Incremental buffered writes over a path (`start`/`write`/`flush`/`end`/`ref`/`unref`); the target opens immediately, writes begin at byte zero without truncating an existing longer file, `end(error)` still commits pending file data, and `highWaterMark` is advisory. `Bun.stdout`/`Bun.stderr` expose the same sink over the fixed descriptor without closing it. |
| `Bun.write` stream input | Partial | `Bun.write` accepts a `ReadableStream` body for file destinations, like `Response` and `Blob` bodies. |
| `Bun.password` | Unsupported | Bun only supports Argon2 and bcrypt here; the native crypto binding provides neither, so exposing a non-interoperable substitute would be unsafe. |
| `Bun.connect`, `Bun.listen` | Partial | TCP-only client/listener over the host Deno net primitives with Bun's callback handlers (`open`/`data`/`end`/`error`/`close`/`drain`/`connectError`), `binaryType` conversion, `end`/`shutdown` half-close, `allowHalfOpen`, and listener `reload` for later connections. `close` fires on every close path including `terminate`; a throwing handler closes the socket after `error`. Unix sockets, TLS, and socket-sharing options are rejected explicitly; `shutdown(true)` terminates the connection because the host read-cancel closes the whole pipe, and `stop()` cannot force-close cleanly-draining sockets. |
| `Bun.stdin`, `Bun.stdout`, `Bun.stderr` | Partial | Descriptor-backed BunFile-like handles with `write`, `writer()`, `text`, `bytes`, `json`, `stream`, and `exists`; `Bun.write(Bun.stdout, ...)` works. stdin reads block synchronously and `stdin.writer()` rejects. |
| `Bun.gc` | Partial | Runs one manual engine sweep and accepts Bun's permissive advisory argument; Bun's eden/full distinction and collection statistics have no engine binding. |
| `Bun.unsafe.memoryFootprint`, `Bun.unsafe.arrayBufferToString` | Partial | `memoryFootprint` reads proportional set size (PSS) from `/proc/self/smaps_rollup` on Linux and returns bytes when the compact kernel report is available and valid; other platforms, restricted `/proc`, missing reports, and malformed values return `undefined`. `arrayBufferToString` safely copies ArrayBuffer and typed-array input with Bun's byte/UTF-16 interpretation; it does not provide Bun's zero-copy lifetime semantics. |
| `Bun.shrink` | Partial | Requests one best-effort engine GC sweep. The host has no separate idle heap-trimming hook, so this is not a guarantee that the process RSS or allocator heap shrinks. |
| `Bun.enableANSIColors` | Supported | Snapshot of whether stdout is a terminal. |
| `Bun.SHA1`, `MD5`, `MD4`, `SHA224`, `SHA256`, `SHA384`, `SHA512`, `SHA512_256`, `sha` | Partial | Bun-compatible one-shot/incremental class APIs; input is buffered until `digest`, and MD4 uses a pure JavaScript implementation. |
| `Bun.Glob` | Partial | Matching plus sync/async local scans, braces, ranges, extglobs and symlink-cycle protection. |
| `Bun.hash` | Partial | Wyhash, Adler-32, CRC-32, CityHash, xxHash32/64 and Murmur v2/v3; xxHash3 and rapidhash are not implemented. |
| `Bun.semver` | Partial | Common npm ranges and comparisons. Some malformed or nonstandard ranges still differ from Bun. |
| `Bun.randomUUIDv5`, `Bun.randomUUIDv7` | Partial | UUIDv5 supports RFC namespace UUIDs plus `dns`, `url`, `oid`, and `x500`; UUIDv7 ordering state is context-local rather than process-shared. |
| Bun stream conversion and file URL helpers | Partial | ArrayBuffer, bytes, text, JSON, array, Blob and FormData consumers, `concatArrayBuffers`, and local file URL conversion. Multipart parsing omits `filename*` and folded headers. |
| `Bun.ArrayBufferSink` | Partial | Incremental UTF-8/binary writes, streaming flushes, reusable `end`, preallocation, and ArrayBuffer/Uint8Array output. |
| `Bun.Cookie`, `Bun.CookieMap` | Partial | Single-cookie parsing/serialization plus cookie-header parsing, mutation, iteration, value encoding, and Set-Cookie output. |
| `Bun.sleepSync`, `Bun.nanoseconds`, `Bun.peek`, `Bun.allocUnsafe`, `Bun.indexOfLine` | Partial | `sleepSync` blocks through the native OS sleep. `nanoseconds` derives from `performance.now()`, so it counts from process start and loses integer exactness past about 104 days. `peek` synchronously observes native promise state. `allocUnsafe` always returns zero-filled memory. |
| `Bun.deepEquals`, `Bun.deepMatch` | Partial | Structural comparison for local-realm builtins; host objects compare by enumerable state. |
| `Bun.JSONC` | Partial | `JSONC.parse` accepts comments and trailing commas. It is not a JSON5 parser. |
| `Bun.JSON5` | Partial | JSON5 parsing and serialization, including comments, unquoted keys, byte inputs and JSON5 numeric syntax. Synchronous Blob input and some proxy-array serialization differ from Bun. |
| `Bun.JSONL` | Partial | Parses complete and streaming JSON Lines from strings and typed-array byte windows, including partial-value and error offsets. |
| `Bun.TOML` | Partial | TOML parsing and serialization for tables, arrays, inline tables, arrays of tables, dates and times. Synchronous Blob input and lone-surrogate replacement differ from Bun. |
| `Bun.color` | Partial | Common CSS names, hex, RGB(A), HSL(A), numeric, array, numeric typed-array (3/4 channel), StringLike and object inputs with common outputs, including truecolor, foreground ANSI 256 (`ansi-256`, `ansi_256`, `ansi256`) and foreground ANSI 16 (`ansi-16`, `ansi_16`). ANSI 256 uses deterministic nearest-color mapping to fixed xterm palette entries 16-255, and ANSI 16 chains through that mapping to the nearest fixed xterm 16-color entry. The automatic `ansi` format picks ansi-16m/ansi-256/ansi-16 from Bun's environment detection (`FORCE_COLOR`, `NO_COLOR`, `TERM`, `TMUX`, `CI`, `TERM_PROGRAM`, `COLORTERM`); Bun 1.4.4 applies this environment table even when stdout is piped. HSL/Lab output remain unsupported and throw. |
| `Bun.stripANSI`, `Bun.stringWidth`, `Bun.sliceAnsi`, `Bun.wrapAnsi` | Partial | ANSI-aware terminal width, slicing and wrapping, including SGR/OSC 8 preservation and `perCodePoint`; East Asian ambiguous widths use a subset table. |
| `Bun.which` | Partial | Executable lookup through `PATH` and `cwd` options, with `PATHEXT` handling on Windows. |
| `Bun.inspect`, `Bun.inspect.custom`, `Bun.inspect.table` | Partial | Primitives, arrays, plain objects, cycles, the custom hook, and table layouts. Special-object and nested table cell formatting inherits the bounded inspector and does not fully match Bun. |
| `Bun.resolve`, `Bun.resolveSync` | Partial | Cached local/lock/store and builtin resolution through CTS with Bun's export condition scoped to each inspection call; never downloads. |
| `Bun.escapeHTML` | Supported | Escapes HTML metacharacters after JavaScript string coercion. |
| Bun package manager/build/test/shell APIs | Unsupported | Outside the current compatibility scope |

Unknown `bun:*` names fail as runtime builtins and never fall back to npm or
network resolution. The bare `bun` module, its default export, and
`globalThis.Bun` share one object per JavaScript context.

## Examples

```ts
import Bun, { file, write } from 'bun';

await write('message.txt', 'hello');
console.log(await file('message.txt').text());
await Bun.sleep(10);
```

```ts
import Bun from 'bun';

const server = Bun.serve({
    port: 3000,
    routes: {
        '/health': new Response('ok'),
        '/echo': { POST: async request => new Response(await request.text()) },
        '/legacy': false,
    },
    fetch: () => new Response('Not Found', { status: 404 }),
});
```

Routes match case-sensitive URL pathnames, ignoring the request query. Matching
prefers exact paths, then parameter patterns (`/users/:id`, one captured segment
each), then wildcard patterns (`/files/*`, everything under the prefix including
`/files/` itself but not the bare `/files`), and among equals the pattern with
more static segments wins, then registration order. The wildcard remainder is
not exposed as a parameter: `params` stays empty for wildcard routes, matching
Bun's current router. Keys must be canonical URL-encoded pathnames beginning
with `/`; raw spaces, non-ASCII characters, backslashes, and paths requiring
dot-segment normalization are rejected, as are `?` and `#`, empty pattern
segments, mid-path wildcards, mixed segments such as `/a:b`, and repeated or
malformed parameter names. Route-dispatched handlers receive a non-enumerable
read-only `params` property holding the decoded `:name` captures (an empty
object for exact and wildcard routes); the fallback `fetch` handler receives a
plain Request. Method maps accept `GET`, `POST`, `PUT`, `DELETE`, `PATCH`,
`HEAD`, and `OPTIONS`; `HEAD` uses `GET` when no explicit `HEAD` handler exists.
An empty object route value is rejected like any other malformed value (earlier
builds silently treated it as an empty method table falling through to fetch).
A `false` route, unmatched path, or unmatched method falls through to `fetch`,
or returns 404 when `fetch` is omitted. A disabled route also stops matching,
so `false` keeps shadowing lower-priority patterns for the same path.
Routes-only servers are supported. Passing `routes` to `server.reload()`
replaces the whole table after validation; omitted or `undefined` routes retain
it, while `{}` clears it. Parameter and wildcard patterns are precompiled and
capped at 1024 entries per table.

Static Response headers are captured at registration, and body buffering starts
once at registration using a single clone. Each cached response is limited to
16 MiB and 16,384 chunks, including empty chunks, and all live tables share a
32 MiB cached-backing-store budget to bound buffering overhead. Because a
stream's final size is not known synchronously, aggregate-budget failures are
reported through the route error path after snapshotting starts rather than by
making `serve()` itself asynchronous.
A failed body snapshot reaches the server's error handler when its route is
requested. Finite stream bodies are buffered rather than streamed; use a
function handler for larger or streaming responses. `cookies` extensions are
not provided. These are the adapter's supported rules and limits, not a claim
of full Bun route parity.

BunFile route values (`Bun.file('./favicon.ico')`) reuse the static snapshot
mechanism: the file body is buffered once at registration into the same 16 MiB
and 32 MiB budgets, `content-type` comes from the file's inferred type, `HEAD`
serves headers without a body copy, and a file missing at registration becomes
a 404 route. A file deleted after registration keeps serving the snapshot.

Directory route values (`{ dir: './public' }` on a key ending in `/*`) stream
each file per request instead of buffering. The remainder after the prefix is
percent-decoded once; remainders with dot or empty segments, encoded
separators, malformed escapes, or NUL are rejected with 404, and the resolved
path must stay inside the root, so symlinks escaping the root 404 instead of
clamping like Bun's `openat2(RESOLVE_IN_ROOT)`. Responses carry `content-type`
from the file extension, `last-modified`, and a weak ETag over the stat pair;
conditional requests support `If-None-Match` and `If-Modified-Since`, and a
single byte range supports open-ended/suffix forms, `If-Range` dates, and 416
for unsatisfiable windows. Multi-range lists and non-byte units receive the full
response. Directory requests without a trailing slash redirect (301) to the
trailing-slash URL, with a trailing slash serve that directory's `index.html`,
and missing files 404. Only GET and HEAD are served; other methods fall through.
The `statCache` option is accepted for Bun parity but no cache is kept.

```ts
import { Database } from 'bun:sqlite';

using db = new Database(':memory:');
db.run('CREATE TABLE messages (text TEXT)');
db.run('INSERT INTO messages VALUES (?)', 'hello');
console.log(db.query('SELECT text FROM messages').get());
```

Behavioral scope and delivery checks are tracked in the root repository's
`docs/bun-compatibility-plan.md`.
