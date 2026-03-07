# CTS

Enable your circu.js to run Deno applications.

## Description

CTS (Circu.js TypeScript Runtime) is a TypeScript bootstrap that provides full TypeScript experience for circu.js. It implements Web API and Deno API polyfills, enabling Deno applications to run in circu.js environment.

Built on QuickJS engine, CTS bridges the gap between circu.js runtime and Deno's API surface, making it possible to run Deno-compatible code with minimal modifications.

## Status

### WebAPI
- [-] Event
  - [x] Event
  - [x] EventTarget
  - [x] CustomEvent
  - [x] MessageEvent
  - [x] CloseEvent
  - [x] ErrorEvent
  - [x] StorageEvent
  - [x] PromiseRejectionEvent
- [-] URL、URLPattern
  - [x] URL
  - [x] URLSearchParams
  - [x] URLPattern (polyfill)
- [-] Stream
  - [x] ReadableStream
  - [x] WritableStream
  - [x] TransformStream
  - [x] ReadableStreamDefaultController
  - [x] WritableStreamDefaultController
- [-] Blob、FormData
  - [x] Blob
  - [x] File
  - [x] FileReader
  - [x] FormData
- [-] AbortSignal
  - [x] AbortController
  - [x] AbortSignal
- [-] Header Request Response
  - [x] Headers
  - [x] Request
  - [x] Response
- [-] fetch
  - [x] fetch API
  - [x] Redirect handling
  - [x] Connection pooling
  - [x] Keep-alive support
- [-] WebSocket
  - [x] WebSocket client
  - [x] WebSocket server upgrade
  - [x] RFC 6455 compliant
- [-] CryptoSubtle crypto
  - [x] crypto.getRandomValues
  - [x] SHA-1, SHA-256, SHA-384, SHA-512
  - [x] AES-CBC, AES-GCM, AES-CTR
  - [x] RSA-OAEP, RSA-PSS, RSASSA-PKCS1-v1_5
  - [x] ECDSA, ECDH
  - [x] HMAC, PBKDF2
  - [x] Key generation, import, export
- [-] performance
  - [x] performance.now()
  - [x] performance.mark()
  - [x] performance.measure()
  - [x] PerformanceObserver
- [-] wasm
  - [x] WebAssembly.compile
  - [x] WebAssembly.instantiate
  - [x] WebAssembly.compileStreaming
  - [x] WebAssembly.instantiateStreaming
- [-] Storage
  - [x] localStorage
  - [x] sessionStorage
  - [x] SQLite-backed persistence
  - [x] WAL mode support
- [-] Temporal
  - [ ] Temporal (polyfill available, not enabled)
- [-] Intl
  - [x] DateTimeFormat
  - [x] NumberFormat
  - [x] RelativeTimeFormat
  - [x] DisplayNames
  - [x] Locale data (zh, en)
- [x] more
  - [x] atob / btoa
  - [x] TextEncoder / TextDecoder
  - [x] setTimeout / setInterval / clearTimeout
  - [x] structuredClone
  - [x] alert / prompt / confirm
  - [x] close
  - [x] reportError
  - [x] EventSource (SSE)

### Deno
- [x] permission (partial)
  - [x] permissions.query (always granted)
  - [ ] permissions.request
  - [ ] permissions.revoke
- [x] unstable
  - [x] ffi (soon)
  - [x] kv
  - [x] vsock
  - [x] multicast
  - [x] datagram (soon)
  - [x] bundle (Deno.bundle)
  - [x] cron
  - [x] ws stream
- [-] basic
  - [x] Deno.pid / Deno.ppid
  - [x] Deno.args
  - [x] Deno.env
  - [x] Deno.exit / Deno.exitCode
  - [x] Deno.build
  - [x] Deno.version
  - [x] Deno.cwd / Deno.chdir
  - [x] Deno.mainModule
  - [x] Deno.execPath
  - [x] Deno.noColor
  - [x] Deno.memoryUsage
  - [x] Deno.systemMemoryInfo
  - [x] Deno.hostname
  - [x] Deno.loadavg
  - [x] Deno.osRelease
  - [x] Deno.osUptime
  - [x] Deno.uid / Deno.gid
  - [x] Deno.inspect
  - [x] Deno.errors
  - [x] Deno.addSignalListener
  - [x] Deno.removeSignalListener
- [-] net
  - [x] Deno.connect (TCP, Unix)
  - [x] Deno.connectTls
  - [x] Deno.listen (TCP, Unix)
  - [x] Deno.listenTls
  - [x] Deno.startTls
  - [x] Deno.resolveDns (A, AAAA, CNAME, MX, NS, PTR, SOA, SRV, TXT, CAA, NAPTR)
  - [x] Deno.networkInterfaces
  - [x] TcpConn / TlsConn / UnixConn
  - [x] Listener / TcpListener / TlsListener
- [-] fs
  - [x] Deno.readFile / readTextFile
  - [x] Deno.writeFile / writeTextFile
  - [x] Deno.readDir
  - [x] Deno.mkdir
  - [x] Deno.remove
  - [x] Deno.rename
  - [x] Deno.copyFile
  - [x] Deno.stat / lstat
  - [x] Deno.truncate
  - [x] Deno.chmod / chown
  - [x] Deno.link / symlink / readLink
  - [x] Deno.realPath
  - [x] Deno.makeTempDir / makeTempFile
  - [x] Deno.open / FsFile
  - [x] Deno.watchFs
- [-] terminal
  - [x] Deno.stdin
  - [x] Deno.stdout
  - [x] Deno.stderr
  - [x] Deno.consoleSize
  - [x] isTerminal
  - [x] setRaw
- [-] process
  - [x] Deno.Command
  - [x] Deno.kill
  - [x] ChildProcess
  - [x] spawn / output / outputSync
  - [ ] Deno.umask
- [-] serve
  - [x] Deno.serve
  - [x] HTTP/1.1 server
  - [x] HTTPS support
  - [x] Request/Response handling
- [-] serve ws
  - [x] Deno.upgradeWebSocket
  - [x] WebSocket server

### CNO Namespace
- [x] CNO.openpty - PTY spawning
- [x] CNO.engine
  - [x] serialize / deserialize
  - [x] evalModule
  - [x] compileModule

### Node.js Compatibility
- [-] fs
  - [x] readFileSync / readFile
  - [x] writeFileSync / writeFile
  - [x] appendFileSync
  - [x] existsSync
  - [x] statSync / lstatSync / fstatSync
  - [x] accessSync
  - [x] mkdirSync / mkdirSync (recursive)
  - [x] rmdirSync / rmSync
  - [x] readdirSync
  - [x] renameSync
  - [x] copyFileSync
  - [x] unlinkSync
  - [x] readlinkSync / symlinkSync / linkSync
  - [x] realpathSync
  - [x] truncateSync / ftruncateSync
  - [x] chmodSync / chownSync / fchmodSync / fchownSync
  - [x] utimesSync / futimesSync
  - [x] openSync / closeSync
  - [x] readSync / writeSync
  - [x] fsyncSync / fdatasyncSync
  - [x] mkdirpSync
  - [x] promises API (async fs operations)
  - [x] callback API
  - [x] constants (F_OK, R_OK, W_OK, X_OK, etc.)
- [x] path
  - [x] join, resolve, normalize, dirname, basename, extname
  - [x] relative, isAbsolute
  - [x] parse, format
  - [x] sep, delimiter
  - [x] win32, posix namespaces
- [x] os
  - [x] hostname, type, platform, arch
  - [x] release, version, uptime
  - [x] cpus, loadavg, freemem, totalmem
  - [x] homedir, tmpdir, userinfo
  - [x] networkInterfaces
  - [x] EOL, constants
- [x] dns
  - [x] lookup, resolve
  - [x] resolve4, resolve6
  - [x] reverse
  - [x] promises API
- [x] events
  - [x] EventEmitter
  - [x] once, on, off
  - [x] captureRejectionSymbol
- [x] util
  - [x] promisify, callbackify
  - [x] inherits
  - [x] isDeepStrictEqual
  - [x] format, inspect
  - [x] types (isArray, isNull, etc.)
- [-] crypto
  - [x] createHash (SHA-1, SHA-256, SHA-512, MD5)
  - [x] createHmac
  - [x] createCipher / createDecipher
  - [x] createSign / createVerify
  - [x] randomBytes
  - [x] pbkdf2 / pbkdf2Sync
  - [x] scrypt / scryptSync
  - [x] constants
- [-] stream
  - [x] Stream (base class)
  - [x] Readable
  - [x] Writable
  - [x] Duplex
  - [x] Transform
  - [x] PassThrough
  - [x] pipeline, finished
  - [x] Readable.from
  - [x] promises namespace
  - [x] addAbortSignal
- [-] net
  - [x] Socket
  - [x] Server
  - [x] createServer
  - [x] connect / createConnection
  - [x] isIP, isIPv4, isIPv6
  - [x] setNoDelay, setKeepAlive
  - [x] setTimeout, ref, unref
- [-] child_process
  - [x] spawn
  - [x] exec, execFile
  - [x] execSync, execFileSync
  - [x] fork (partial)
  - [x] ChildProcess class
  - [x] stdin/stdout/stderr streams
- [x] buffer
  - [x] Buffer class
  - [x] Buffer.from, Buffer.alloc, Buffer.allocUnsafe
  - [x] Buffer.concat, Buffer.isBuffer
  - [x] Buffer.byteLength
  - [x] toString, toJSON, equals, compare
  - [x] slice, subarray, copy, fill
  - [x] readInt*, writeInt*, readUInt*, writeUInt*
  - [x] transcode
- [-] zlib
  - [x] deflate / deflateSync / deflateRaw / deflateRawSync
  - [x] inflate / inflateSync / inflateRaw / inflateRawSync
  - [x] gzip / gzipSync / gunzip / gunzipSync
  - [x] unzip / unzipSync
  - [x] brotliCompress / brotliDecompress
  - [x] constants (compression levels, strategies, etc.)
  - [x] createDeflate, createInflate, etc.
- [-] dgram
  - [x] createSocket (udp4, udp6)
  - [x] bind, send, close
  - [x] addMembership, dropMembership
  - [x] setBroadcast, setTTL, setMulticastTTL
  - [x] address, remoteAddress
  - [x] message, listening, error, close events
- [-] process
  - [x] argv, argv0, execArgv
  - [x] env (Proxy-based)
  - [x] cwd, chdir
  - [x] exit, exitCode
  - [x] pid, ppid
  - [x] platform, arch
  - [x] version, versions
  - [x] title
  - [x] execPath
  - [x] memoryUsage, cpuUsage
  - [x] hrtime, uptime
  - [x] nextTick
  - [x] kill, abort
  - [x] signal handling (on, off, once)
  - [x] getuid, getgid, geteuid, getegid
  - [x] umask
  - [x] config, release, features
  - [x] report, resourceUsage
  - [x] emitWarning
  - [x] permission.has
- [x] timers
  - [x] setTimeout, clearTimeout
  - [x] setInterval, clearInterval
  - [x] setImmediate, clearImmediate
  - [x] promises namespace (setTimeout, scheduler)

## Architecture

CTS loads in the following order:

1. **WebAPI** (`src/webapi/`) - Web standard API polyfills
2. **Deno** (`src/deno/`) - Deno runtime API implementation
3. **CJS** (`src/cjs/`) - CNO private namespace and extensions (PTY, engine)
4. **Module** (`src/module/`) - HTTP module (fetch, websocket, SSE, server)

## Project Structure

```
denort/
├── src/
│   ├── main.ts              # Entry point
│   ├── webapi/              # Web API polyfills
│   │   ├── basic.ts         # atob, btoa, TextEncoder, timers, etc.
│   │   ├── url.ts           # URL, URLSearchParams
│   │   ├── streams.ts       # ReadableStream, WritableStream
│   │   ├── crypto.ts        # SubtleCrypto implementation
│   │   ├── performance.ts   # Performance API
│   │   ├── storage.ts       # localStorage, sessionStorage
│   │   ├── intl.ts          # Intl API
│   │   ├── wasm.ts          # WebAssembly
│   │   └── events.ts        # Event, EventTarget
│   ├── deno/                # Deno API implementation
│   │   ├── 00_permission.ts # Permission system
│   │   ├── 01_errors.ts     # Deno error classes
│   │   ├── 02_fs.ts         # File system operations
│   │   ├── 03_fopen.ts      # File handle (FsFile)
│   │   ├── 04_stdio.ts      # stdin, stdout, stderr
│   │   ├── 05_net.ts        # TCP, TLS, Unix sockets
│   │   ├── 06_process.ts    # Process spawning
│   │   ├── 07_http.ts       # HTTP utilities
│   │   └── 08_serve.ts      # Deno.serve, upgradeWebSocket
│   ├── cjs/                 # CNO namespace
│   │   ├── pty.ts           # PTY spawning
│   │   └── engine.ts        # Engine utilities
│   ├── module/              # HTTP module
│   │   └── http/
│   │       ├── fetch.ts     # fetch API
│   │       ├── websocket.ts # WebSocket
│   │       ├── sse.ts       # EventSource
│   │       ├── server.ts    # HTTP server
│   │       ├── connection.ts# Connection pooling
│   │       └── http.ts      # HTTP parser/builder
│   ├── node/                # Node.js compatibility
│   └── utils/               # Utility functions
├── example/                 # Example projects
├── types/                   # Type definitions
├── dist.js                  # Bundled output
└── Makefile
```

## Build

```bash
# Install dependencies
pnpm install

# Build bundle
pnpm run build

# Bundle to single file
pnpm run bundle

# Build node polyfills (requires cts)
make
```

## Usage

After building, `dist.js` can be loaded in circu.js environment to provide Deno-compatible APIs.

```javascript
// File system
const data = await Deno.readTextFile("./example.txt");
console.log(data);

// HTTP client
const response = await fetch("https://api.example.com/data");
const json = await response.json();

// HTTP server
Deno.serve({ port: 8000 }, (request) => {
  return new Response("Hello World");
});

// WebSocket
const ws = new WebSocket("wss://example.com/socket");
ws.onmessage = (e) => console.log(e.data);

// Process spawning
const cmd = new Deno.Command("echo", { args: ["hello"] });
const { stdout } = await cmd.output();

// Network
const conn = await Deno.connect({ hostname: "example.com", port: 80 });
await conn.write(new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n"));
```

## Dependencies

### Web API Polyfills
- `web-streams-polyfill` - Streams API
- `formdata-polyfill` - FormData
- `blob-polyfill` - Blob/File
- `abortcontroller-polyfill` - AbortController/AbortSignal
- `urlpattern-polyfill` - URLPattern
- `whatwg-url` - URL implementation
- `headers-polyfill` - Headers API
- `temporal-polyfill` - Temporal API
- `@formatjs/intl` - Intl API

### Build Tools
- `esbuild` - Bundling
- `sucrase` - TypeScript transformation

## License

MIT
