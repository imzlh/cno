# Zygote HTTP Supervisor

This Linux-only example preloads ordinary JavaScript state once and forks two
long-lived HTTP roles from the same runtime image. `zygote.ts` is a small,
reusable prefork supervisor; `index.ts` supplies the example roles.

## Run

Rebuild the native binary first, then run from the repository root:

```sh
build/stage/cno run cno/example/zygote/index.ts
```

The services listen on `127.0.0.1:8780` (`video`) and `127.0.0.1:8781` (`ai`):

```sh
curl http://127.0.0.1:8780/health
curl http://127.0.0.1:8781/health
```

Both responses include native `os.pid`/`os.ppid`, `Deno.pid`, and the
pre-fork-materialized Node `process.pid`, plus the same
`preloadedAt`/`signature` state. Change the port pair and shutdown deadline with:

```sh
CNO_ZYGOTE_BASE_PORT=9000 \
CNO_ZYGOTE_SHUTDOWN_TIMEOUT_MS=3000 \
build/stage/cno run cno/example/zygote/index.ts
```

Matching inherited values demonstrate that the child resumed with the
preloaded JS state; they do not measure physical page sharing. For memory
comparisons, inspect `Pss`, `Pss_Anon`, and `Private_*` in each Linux
`/proc/<pid>/smaps_rollup`. Summing RSS counts shared pages once per process and
therefore overstates the zygote group's physical footprint.

## Fork contract

```ts
const child = import.meta.use('process').fork();

if (child === null) {
    // Child: execution continues from the fork call.
} else {
    // Parent: child.pid / child.kill() / child.wait() / child.waitSync().
}
```

`fork()` does not exec a new image, replace argv/env/cwd, or configure stdio.
All open file descriptors retain normal POSIX inheritance behavior.

The example wraps the primitive with:

- `runZygote({ roles, shutdownTimeoutMs, onForked })`, which forks every role
  before installing parent signal handlers, timers, or async wait promises,
  then invokes the optional `onForked` callback;
- `serveHttp(context, options, handler)`, which connects the child abort signal
  to `Deno.HttpServer.shutdown()` for graceful HTTP shutdown;
- typed child context/results and a fail-fast group policy.

If any fork fails midway, the supervisor sends SIGKILL to the children already
created and reaps them synchronously before rethrowing. If any role exits while
the group is running, the parent sends SIGTERM to its siblings. Once the child
signal handlers are active, SIGINT or SIGTERM starts the same graceful stop. A
second signal, or expiry of `shutdownTimeoutMs`, escalates remaining children
to SIGKILL. The parent waits for and reports every final `ExitInfo`. The
example leaves `Deno.exitCode` at zero after a clean signal-driven stop and
makes an unexpected/forced stop non-zero so an external service manager can
restart the group.

Press Ctrl-C or send `kill -TERM <parent-pid>`; the parent PID is printed after
all roles have been forked. `onForked` is deliberately not named `onReady`: it
does not promise that children have installed their own signal handlers or that
HTTP listeners are accepting yet. A service-level readiness guarantee needs a
child-to-parent IPC acknowledgement, which this fd-inheriting primitive does
not hide behind a misleading callback.
The callback may return a promise for short asynchronous bookkeeping, but a
pending callback is not allowed to hold up reaping once every child has
finished; readiness and long-running supervision belong to the child roles.

There is also an unavoidable pure-JS signal window while the parent is
forking: it cannot install a libuv signal watcher before `fork()` without
copying that active handle into every child. A signal in that window can stop
the parent and leave already-created children orphaned. For production, run
the group in a service-manager cgroup (for example, systemd with
`KillMode=control-group`). Closing the window inside CNO would require native
signal masking around the complete fork sequence, plus a child readiness
handshake if graceful shutdown must be guaranteed immediately after startup.

## Pre-fork rules

Keep everything before `runZygote()` synchronous and fork-safe:

- preload JS modules, parsed configuration, route tables, and other immutable
  JS data;
- do not create a CNO Worker, inspector, HTTP server, timer, event/signal
  listener, socket, spawned process, PTY, DNS request, async filesystem
  operation, pending microtask, or `uv_queue_work` task; `fork()` explicitly
  rejects active/closing spawned-process and PTY handles;
- statically load every module needed by a child before forking; do not perform
  an uncached dynamic `import()` or `require()` in the child against inherited
  loader, lock-store, or native resolver state;
- do not assume `uv_loop_fork()` repairs arbitrary native-extension or library
  state; extension-managed threads, locks, and callbacks remain unsupported;
- create listeners in the selected child, normally on a different port per
  role, unless sharing a deliberately prepared inherited descriptor.

`Deno.pid` and Node-compatible `process.pid` are backed by live native getters,
so preloaded Express/Hono code sees the child identity after fork. The child
context also exposes native `pid`/`ppid` values directly.

The supervisor intentionally does not restart one role in place. Once the
parent has installed active signal/wait handles, another raw fork would copy
that live state into the replacement child. Let systemd, OpenRC, or another
external supervisor restart the whole zygote group instead.
