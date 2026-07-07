# cno

`cno/` is the runtime polyfill layer used by `cno-cli`. It installs Web APIs,
Deno APIs, Node.js compatibility modules, and the `CNO` namespace on top of the
`circu.js` native runtime.

This directory is loaded by the CLI through:

```ts
await import('../cno/src/main');
```

`cno/src/main.ts` currently installs, in order:

```text
webapi/index
deno/index
cno/index
node/_internal/inject
```

## Directory Layout

| Path | Role |
| --- | --- |
| `src/webapi/` | Web platform APIs such as fetch, streams, events, URL, crypto, WebSocket |
| `src/deno/` | Deno namespace APIs such as fs, net, process, serve, kv, ffi |
| `src/node/` | Node.js builtin modules and globals |
| `src/cno/` | CNO-specific APIs such as engine helpers, pty, ssl, compression |
| `src/utils/` | Shared runtime helpers |
| `src/type/` | Type declarations for the CNO namespace |
| `utils/` | Build/install helpers for Node polyfill files |
| `example/` | Small usage examples |

## Web API Layer

The Web API layer is installed from `src/webapi/index.ts`. It provides the
browser-like globals that Deno-style programs expect, including:

- timers and microtasks
- console
- events and `EventTarget`
- `URL`, `URLSearchParams`, and `URLPattern`
- `TextEncoder` and `TextDecoder`
- `Blob`, `File`, `FormData`
- `ReadableStream`, `WritableStream`, `TransformStream`
- `AbortController` and `AbortSignal`
- `fetch`, `Request`, `Response`, `Headers`, and `XMLHttpRequest`
- `WebSocket`, `EventSource`, and WebTransport-related entry points
- `crypto` and `crypto.subtle`
- `performance`
- `navigator`
- `localStorage`, `sessionStorage`, and Cache API pieces
- WebAssembly helpers

HTTP fetch currently uses the fetch implementation under
`src/webapi/fetch/`, backed by native/runtime facilities. Long-lived protocol
transports also use helpers from `@cnojs/http`.

## Deno Layer

The Deno namespace is assembled in `src/deno/index.ts` and split into numbered
modules:

| File | Area |
| --- | --- |
| `00_permission.ts` | Permission compatibility surface |
| `01_errors.ts` | `Deno.errors` |
| `02_fs.ts` | File system functions |
| `03_fopen.ts` | `Deno.open` and file handles |
| `04_stdio.ts` | stdin, stdout, stderr |
| `05_net.ts` | TCP, TLS, Unix sockets, DNS |
| `06_process.ts` | `Deno.Command` and process handling |
| `07_http.ts` | HTTP client helpers |
| `08_serve.ts` | `Deno.serve` and websocket upgrade |
| `09_cron.ts` | Cron compatibility surface |
| `10_quic.ts` | QUIC/WebTransport integration |
| `ffi/` | `Deno.dlopen` and unsafe pointer/callback APIs |
| `kv/` | SQLite-backed KV implementation |

Permissions are compatibility-oriented rather than a sandbox. Deno permission
flags accepted by the CLI are currently no-ops.

## Node.js Layer

Node builtin modules live under `src/node/<name>/`. Each module generally has:

```text
mod.ts    implementation and exports
index.ts  resolver-facing entry
```

Implemented or partially implemented surfaces include:

```text
assert, async_hooks, buffer, child_process, console, constants, crypto,
dgram, diagnostics_channel, dns, events, fs, http, http2, https, inspector,
ipc_channel, module, net, os, path, perf_hooks, process, punycode,
querystring, readline, repl, sqlite, sqlite3, stream, string_decoder, timers,
tls, tty, url, util, v8, vm, wasi, worker_threads, zlib
```

`src/node/_internal/inject.ts` wires selected globals:

- `process`
- `Buffer`
- `http.__cno` for Node HTTP server integration

Node builtin polyfills are resolved by CTS from the cache directory. In a
development checkout, refresh them with:

```sh
build/stage/cno setup
```

## CNO Namespace

`src/cno/index.ts` installs project-specific APIs under `CNO`, including:

- `CNO.engine`
- `CNO.openpty`
- SSL helpers
- compression helpers
- llhttp helpers

These are runtime-specific APIs, not Deno or Node compatibility APIs.

## Compatibility Status

This README lists implementation areas and source ownership. It is not a claim
that every listed upstream API is complete. Use `../docs/compatibility.md` for
status language and compatibility boundaries.

## Build And Validation

From the repository root:

```sh
pnpm run type-check
cmake --build build
```

After changing only `cno/src/node/` files, the staged runtime usually only
needs its cached Node polyfills refreshed:

```sh
build/stage/cno setup
```

Focused test buckets:

```sh
build/stage/cno test tests/webapi
build/stage/cno test tests/deno
build/stage/cno test tests/node
```

## Maintenance Notes

- Keep Node module implementations inside `cno/src/node/` unless there is a
  deliberate shared runtime boundary.
- Use `import.meta.use()` for native runtime modules instead of global shortcuts
  inside polyfill code.
- When runtime behavior changes, check the exported TypeScript surface where
  applicable.
- The old package name in `cno/package.json` is not a reliable description of
  this directory; treat this README and the source layout as the current guide.
