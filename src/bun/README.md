# Bun Compatibility

This directory implements cno's incremental Bun compatibility layer. It uses
the existing Web, Deno, Node, and native runtime primitives; it does not embed
Bun or JavaScriptCore. Upstream `@types/bun` is the typing target, not a claim
that every declared API exists at runtime.

## Current Surface

| Surface | Status | Notes |
| --- | --- | --- |
| `globalThis.Bun`, `bun` | Partial | One shared namespace for lifecycle, file, HTTP, process and the helpers listed below; not the full Bun namespace |
| `Bun.fetch` | Partial | Reuses cno's global Web fetch; Bun-specific fetch options are rejected rather than silently ignored. |
| `Bun.isMainThread` | Supported | Reports whether the current runtime is a worker. |
| `Bun.file`, `Bun.write` | Partial | Local paths, file URL objects and UTF-8 byte paths, lazy file blobs, slices, reads, stats, deletion, and instance writes. Invalid UTF-8 byte paths are rejected because the string-based host filesystem API cannot represent them safely. `Bun.write` accepts strings, bytes, Blob and Response; `BunFile.write` also accepts Request and ReadableStream. File descriptors, FileSink/`writer()` and special stdio/S3 files are unsupported. |
| `Bun.dns` | Partial | `lookup` and resolver flag constants use asynchronous system getaddrinfo with TTL 0. Explicit c-ares selection is rejected; UDP socket type and port do not affect resolution. Prefetch and shared connection cache statistics are unsupported. |
| `Bun.serve` | Partial | HTTP over `Deno.serve` with `fetch`, `error`, `port` and `hostname`; `server.reload()` updates fetch/error handlers without rebinding. No TLS, WebSocket, routes, automatic hot reload, or forceful stop. |
| `Bun.spawn`, `Bun.spawnSync` | Partial | Native subprocess adapter with stdio and exit handling; IPC, cgroups and terminals are unsupported. Sync also rejects `signal`, `timeout`, `maxBuffer`, and `argv0`; async per-child `resourceUsage` is unavailable. |
| `bun:sqlite` | Partial | Database and Statement queries, bindings, transactions, caching, and close semantics; `Statement.raw` and `columnTypes` are unsupported. |
| `Bun.gzipSync`, `gunzipSync`, `deflateSync`, `inflateSync` | Partial | One-shot gzip and raw-DEFLATE helpers over the native zlib binding; zstd is not implemented. |
| `Bun.CryptoHasher` | Partial | Incremental hashes and supported HMAC algorithms; `blake2b256` and `blake2b512` use Bun's keyed-BLAKE2b semantics for the second constructor argument (pure JavaScript), and `md4` uses a pure JavaScript implementation. |
| `BunFile.writer()` (FileSink) | Partial | Incremental buffered writes over a path (`start`/`write`/`flush`/`end`/`ref`/`unref`); the file is opened and truncated on first flush, `end(error)` discards pending data, and `highWaterMark` commits eagerly. `Bun.stdout`/`Bun.stderr` expose the same sink over the fixed descriptor without closing it. |
| `Bun.write` stream input | Partial | `Bun.write` accepts a `ReadableStream` body for file destinations, like `Response` and `Blob` bodies. |
| `Bun.password` | Unsupported | Bun only supports Argon2 and bcrypt here; the native crypto binding provides neither, so exposing a non-interoperable substitute would be unsafe. |
| `Bun.connect`, `Bun.listen` | Partial | TCP-only client/listener over the host Deno net primitives with Bun's callback handlers (`open`/`data`/`end`/`error`/`close`/`drain`/`connectError`), `binaryType` conversion, `end`/`shutdown` half-close, `allowHalfOpen`, and listener `reload` for later connections. `close` fires on every close path including `terminate`; a throwing handler closes the socket after `error`. Unix sockets, TLS, and socket-sharing options are rejected explicitly; `shutdown(true)` terminates the connection because the host read-cancel closes the whole pipe, and `stop()` cannot force-close cleanly-draining sockets. |
| `Bun.stdin`, `Bun.stdout`, `Bun.stderr` | Partial | Descriptor-backed BunFile-like handles with `write`, `writer()`, `text`, `bytes`, `json`, `stream`, and `exists`; `Bun.write(Bun.stdout, ...)` works. stdin reads block synchronously and `stdin.writer()` rejects. |
| `Bun.gc` | Partial | Runs one manual engine sweep; Bun's eden/full distinction has no engine binding, and non-boolean `force` arguments throw (stricter than Bun's coercion). |
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
| `Bun.color` | Partial | Common CSS names, hex/rgb(a), numeric, array and object inputs with common output formats. HSL/Lab, ANSI 16/256 and automatic ANSI output are unsupported and throw. |
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
import { Database } from 'bun:sqlite';

using db = new Database(':memory:');
db.run('CREATE TABLE messages (text TEXT)');
db.run('INSERT INTO messages VALUES (?)', 'hello');
console.log(db.query('SELECT text FROM messages').get());
```

Behavioral scope and delivery checks are tracked in the root repository's
`docs/bun-compatibility-plan.md`.
