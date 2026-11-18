import packageJson from '../../package.json';
import { buildDenoArgs } from "../utils/args";
import { toFsPath } from "../utils/path";
import { wrapFSErr } from "../utils/wrap";
import { errors } from "./01_errors";
import { defineLazy } from "../utils/lazy-accessor";
import { getEnv } from "../utils/env";
import { dispatchLoadEvent, dispatchUnloadEvent } from "../webapi/event-mux-bootstrap";
import {
    afterAllHooks,
    afterEachHooks,
    beforeAllHooks,
    beforeEachHooks,
    benchRegistry,
    createBenchContext,
    createBenchFunction,
    createTestContext,
    createTestFunction,
    failedTests,
    filterMatches,
    getFailedTests,
    runTestHook,
    testRegistry,
    toError,
    type IFailedTest,
    type StartTestOptions,
} from "./utils/tests";
export type { IFailedTest, StartTestOptions };
export { getFailedTests };

const os = import.meta.use('os');
const engine = import.meta.use('engine');
const signal = import.meta.use('signals');
const console = import.meta.use('console');
const timers = import.meta.use('timers');
const ev = import.meta.use('evbus');
const error = import.meta.use('error');

const kInternal = Symbol('Deno.internal');

// ─── CLI runtime channel ─────────────────────────────────────────────────────

/** Entry URL the CLI published before dispatch; absent in library embeddings. */
function mainScriptUrl(): string | undefined {
    const value = ev.get<string>('cno.runtime', 'mainScript');
    return typeof value === 'string' ? value : undefined;
}

function pathFromStringOrUrl(path: string | URL): string {
    if (!(path instanceof URL)) return path;
    if (path.protocol !== 'file:') throw new TypeError('Expected a file URL');
    return toFsPath(path);
}

function pathFromURL(url: URL): string {
    if (!(url instanceof URL)) throw new TypeError('Expected a URL');
    if (url.protocol !== 'file:') throw new TypeError('Expected a file URL');
    return toFsPath(url);
}

function denoChdir(dir: string | URL): void {
    try {
        os.chdir(pathFromStringOrUrl(dir));
    } catch (error) {
        throw wrapFSErr(error);
    }
}

function notSupported(): never {
    throw new errors.NotSupported("Not supported");
}

function toDenoSystemName(name: string): string {
    if (name.includes('MINGW') || name == 'Windows_NT') return 'windows';
    // uname reports 'Darwin' on macOS — 'macOS' is never a uname sysname.
    if (name == 'Darwin' || name == 'macOS') return 'darwin';
    if (name == 'FreeBSD') return 'freebsd';
    if (name == 'NetBSD') return 'netbsd';
    return 'linux';
}

/** Deno.build.arch is only ever 'x86_64' or 'aarch64' — normalize uname names. */
function toDenoArch(arch: string): string {
    if (arch === 'x86_64' || arch === 'x64' || arch === 'amd64' || arch === 'AMD64') return 'x86_64';
    if (arch === 'aarch64' || arch === 'arm64' || arch === 'ARM64') return 'aarch64';
    return arch;
}

/** Map uname.machine + toDenoSystemName to a standard Rust-style target triple. */
function toDenoTarget(arch: string, os: string): string {
    const a = toDenoArch(arch);
    if (os === 'windows') return `${a}-pc-windows-msvc`;
    if (os === 'darwin')  return `${a}-apple-darwin`;
    if (os === 'freebsd') return `${a}-unknown-freebsd`;
    if (os === 'netbsd')  return `${a}-unknown-netbsd`;
    // Runtime uname data cannot reliably distinguish Linux glibc from musl.
    return `${a}-unknown-linux-gnu`;
}

function createDenoBuild(arch: string, os: string) {
    const target = toDenoTarget(arch, os);
    const [targetArch, vendor, targetOs, env] = target.split('-');
    return Object.freeze({
        target,
        arch: targetArch,
        os: targetOs,
        vendor,
        env,
        standalone: false,
    });
}

const signalMap: Record<string, Map<() => void, CModuleSignals.SignalHandler>> = {};
const signalAliases: Record<string, string> = {
    SIGIO: 'SIGPOLL',
    SIGUNUSED: 'SIGSYS',
};
const forbiddenSignals = new Set(['SIGKILL', 'SIGSTOP', 'SIGILL', 'SIGFPE', 'SIGSEGV']);

function toEnvKey(key: unknown): string {
    if (typeof key === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    const envKey = String(key);
    if (envKey.length === 0) throw new TypeError('Key is an empty string');
    if (envKey.includes('\0')) throw new TypeError('Key contains invalid characters: "\\0"');
    if (envKey.includes('=')) throw new TypeError('Key contains invalid characters: "="');
    return envKey;
}

function toEnvValue(value: unknown): string {
    if (typeof value === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    const envValue = String(value);
    if (envValue.includes('\0')) throw new TypeError('Value contains invalid characters: "\\0"');
    return envValue;
}

function setEnv(key: unknown, value: unknown): void {
    os.setenv(toEnvKey(key), toEnvValue(value));
}

function deleteEnv(key: unknown): void {
    os.unsetenv(toEnvKey(key));
}

function normalizeSignalName(sig: unknown): string {
    if (typeof sig !== 'string') throw new TypeError(`Invalid signal: ${String(sig)}`);
    if (forbiddenSignals.has(sig)) {
        throw new TypeError(`Binding to signal '${sig}' is not allowed`);
    }
    return signalAliases[sig] ?? sig;
}

function safeGetEnv(env: unknown): string | undefined {
    return getEnv(toEnvKey(env));
}

const customInspectSymbol = Symbol.for('Deno.customInspect');

type CustomInspectable = {
    [customInspectSymbol]?: unknown;
};

type InspectOptionsWithCustom = Deno.InspectOptions & {
    customInspect?: boolean;
};

function toNativeInspectOptions(opt?: Deno.InspectOptions) {
    return {
        colors: opt?.colors ?? Deno.noColor,
        depth: opt?.depth ?? undefined,
        showHidden: opt?.showHidden ?? false,
        breakLength: opt?.breakLength,
        compact: opt?.compact,
        maxArrayLength: opt?.iterableLimit,
        maxStringLength: opt?.strAbbreviateSize
    };
}

function iteratorToArray(iterator: unknown): unknown[] {
    if (!iterator || (typeof iterator !== 'object' && typeof iterator !== 'function')) return [];
    const next = Reflect.get(iterator, 'next');
    if (typeof next !== 'function') return [];
    const out: unknown[] = [];
    while (true) {
        const step = Reflect.apply(next, iterator, []);
        if (!step || typeof step !== 'object') break;
        if (Reflect.get(step, 'done') === true) break;
        out.push(Reflect.get(step, 'value'));
    }
    return out;
}

function inspectErrorCause(value: unknown, seen: WeakSet<object>): string {
    if (value && (typeof value === 'object' || typeof value === 'function')) {
        const objectValue = Object(value);
        if (seen.has(objectValue)) return '[Circular]';
        return inspectRealmValue(value, seen) ?? String(console.inspect(value, { colors: false, depth: 2, showHidden: false }));
    }
    return String(console.inspect(value, { colors: false, depth: 2, showHidden: false }));
}

function inspectRealmValue(value: unknown, seen: WeakSet<object> = new WeakSet()): string | undefined {
    let tag = '';
    try {
        tag = Object.prototype.toString.call(value);
    } catch {
        return undefined;
    }
    if (tag === '[object Date]') {
        const getTime = Reflect.get(Object(value), 'getTime');
        let timeValue: unknown = NaN;
        try {
            if (typeof getTime === 'function') timeValue = Reflect.apply(getTime, value, []);
        } catch {
            return 'Invalid Date';
        }
        const time = typeof timeValue === 'number' ? timeValue : NaN;
        return Number.isNaN(time) ? 'Invalid Date' : new Date(time).toISOString();
    }
    if (tag === '[object Error]' || value instanceof Error) {
        const error = Object(value);
        const base = `${String(Reflect.get(error, 'name') || 'Error')}: ${String(Reflect.get(error, 'message') || '')}`;
        if (!Object.prototype.hasOwnProperty.call(error, 'cause')) return base;
        seen.add(error);
        return `${base}\nCaused by ${inspectErrorCause(Reflect.get(error, 'cause'), seen)}`;
    }
    if (tag === '[object Map]') {
        const map = Object(value);
        const getEntries = Reflect.get(map, 'entries');
        let entries: unknown[] = [];
        try {
            if (typeof getEntries === 'function') entries = iteratorToArray(Reflect.apply(getEntries, map, []));
        } catch {
            return 'Map { }';
        }
        const shown = entries.slice(0, 3).map((entry) => {
            if (!Array.isArray(entry)) return inspectMapSetItem(entry);
            return `${inspectMapSetItem(entry[0])} => ${inspectMapSetItem(entry[1])}`;
        }).join(', ');
        const sizeValue = Reflect.get(map, 'size');
        const size = typeof sizeValue === 'number' ? sizeValue : entries.length;
        return `Map(${size}) {${shown}${size > 3 ? ', ...' : ''}}`;
    }
    if (tag === '[object Set]') {
        const set = Object(value);
        const getValues = Reflect.get(set, 'values');
        let values: unknown[] = [];
        try {
            if (typeof getValues === 'function') values = iteratorToArray(Reflect.apply(getValues, set, []));
        } catch {
            return 'Set { }';
        }
        const shown = values.slice(0, 3).map(inspectMapSetItem).join(', ');
        const sizeValue = Reflect.get(set, 'size');
        const size = typeof sizeValue === 'number' ? sizeValue : values.length;
        return `Set(${size}) {${shown}${size > 3 ? ', ...' : ''}}`;
    }
}

function inspectMapSetItem(value: unknown): string {
    return inspectRealmValue(value) ?? String(console.inspect(value, { colors: false, depth: 2, showHidden: false }));
}

type TestDefinitionWithNoRun = Deno.TestDefinition & { noRun?: boolean };

export async function startTest(contextName = '<core>', test = true, bench = true, options: StartTestOptions = {}) {
    // 'load' before the suite, 'unload' after; evaluate lazy feature modules
    // before the first test body. Docs: docs/webapi-notes.md
    await Promise.all(lazyModules);
    if (test) dispatchLoadEvent();

    // reportError / uncaught errors during a test fail the suite (specs/test/report_error).
    // Listeners may preventDefault on cancelable ErrorEvents (reportError is cancelable).
    let suiteUncaught: Error | null = null;
    const onSuiteError = (ev: Event) => {
        if (!(ev instanceof ErrorEvent)) return;
        if (suiteUncaught) return;
        const err = ev.error instanceof Error ? ev.error : new Error(String(ev.message || 'Uncaught error'));
        // Defer so same-turn preventDefault from user listeners still wins.
        queueMicrotask(() => {
            if (ev.defaultPrevented) return;
            if (!suiteUncaught) suiteUncaught = err;
        });
    };
    if (test) {
        // Installed unconditionally by the webapi boot; see webapi/index.ts.
        globalThis.addEventListener('error', onSuiteError);
    }

    try {
    if (test) {
        // Run beforeAll hooks (registration order)
        for (const hook of beforeAllHooks) {
            await runTestHook(hook, 'beforeAll hook', 'beforeAll hook failed');
        }

        const hasOnly = testRegistry.some(t => t.only);
        let stopTests = options.failFast === true && failedTests.length > 0;

        for (const testItem of testRegistry) {
            if (stopTests || suiteUncaught) break;
            if (hasOnly && !testItem.only) continue;
            if (!filterMatches(testItem.name, options.filter)) continue;
            if ((testItem as TestDefinitionWithNoRun).noRun) continue;
            if (testItem.ignore) {
                console.warn(`  skip ${testItem.name}`);
                continue;
            }

            const repeats = testItem.repeats ?? 0;
            const retryCount = testItem.retry ?? 0;
            const totalRuns = repeats + 1;

            for (let run = 0; run < totalRuns; run++) {
                if (stopTests || suiteUncaught) break;
                const runLabel = totalRuns > 1 ? `${testItem.name} (${run + 1}/${totalRuns})` : testItem.name;
                const failureCountBefore = failedTests.length;

                // beforeEach hooks (registration order)
                for (const hook of beforeEachHooks) {
                    await runTestHook(
                        hook,
                        `beforeEach hook for ${runLabel}`,
                        `beforeEach hook failed for ${runLabel}`,
                    );
                }

                let lastError: unknown;
                let success = false;

                for (let attempt = 0; attempt <= retryCount; attempt++) {
                    const stepCtx = createTestContext(runLabel, contextName);
                    try {
                        if (testItem.timeout && testItem.timeout > 0) {
                            const timeout = testItem.timeout;
                            let timeoutId = 0;
                            await Promise.race([
                                testItem.fn(stepCtx),
                                new Promise<never>((_, reject) => {
                                    timeoutId = timers.setTimeout(() => reject(new Error(`Test timed out after ${timeout}ms`)), timeout);
                                }),
                            ]).finally(() => {
                                if (timeoutId) timers.clearTimeout(timeoutId);
                            });
                        } else {
                            await testItem.fn(stepCtx);
                        }
                        // Drain reportError microtask before sanitizers (preventDefault race).
                        await Promise.resolve();
                        success = true;
                        break;
                    } catch (e) {
                        lastError = e;
                        if (attempt < retryCount) {
                            console.warn(`  retry ${runLabel} (attempt ${attempt + 2}/${retryCount + 1})`);
                        }
                    }
                }
                // Drain once more after attempts (uncaught may queue after throw path).
                await Promise.resolve();

                // specs/test/exit_code*: non-zero Deno.exitCode fails a clean test and resets;
                // if the test already threw, keep the sticky code for later tests.
                if (denoExitCode !== 0) {
                    if (success) {
                        success = false;
                        lastError = new Error(`Test case finished with exit code set to ${denoExitCode}`);
                        setDenoExitCode(0);
                    }
                }

                if (suiteUncaught && success) {
                    success = false;
                    lastError = suiteUncaught;
                }

                if (success) {
                    console.info(`  ok ${runLabel}`);
                } else {
                    console.error(`  fail ${runLabel}`, lastError);
                    failedTests.push({ ...testItem, name: runLabel, error: toError(lastError) });
                }

                // afterEach hooks run LIFO (Deno/Jest style)
                for (const hook of [...afterEachHooks].reverse()) {
                    await runTestHook(
                        hook,
                        `afterEach hook for ${runLabel}`,
                        `afterEach hook failed for ${runLabel}`,
                    );
                }

                if (options.failFast === true && failedTests.length > failureCountBefore) {
                    stopTests = true;
                    break;
                }
                if (suiteUncaught) {
                    stopTests = true;
                    break;
                }
            }
        }

        // afterAll hooks run LIFO
        for (const hook of [...afterAllHooks].reverse()) {
            await runTestHook(hook, 'afterAll hook', 'afterAll hook failed');
        }

        // only option fails the overall run even when selected tests pass
        if (hasOnly) {
            failedTests.push({
                name: 'only option',
                fn: () => {},
                error: new Error('Test failed because the "only" option was used'),
            });
        }
        if (suiteUncaught && !failedTests.some(t => t.error === suiteUncaught)) {
            failedTests.push({
                name: `${contextName} (uncaught error)`,
                fn: () => {},
                error: suiteUncaught,
            });
        }
    }

    if (bench) {
        const hasOnly = benchRegistry.some(b => b.only);
        for (const benchItem of benchRegistry) {
            try {
                if (hasOnly && !benchItem.only) continue;
                if (benchItem.ignore) {
                    console.warn(`  skip ${benchItem.name}`);
                    continue;
                }
                const bctx = createBenchContext(benchItem.name, contextName);
                bctx.start();
                await benchItem.fn(bctx);
                bctx.end();
            } catch (e) {
                console.error(`  fail ${benchItem.name}`);
                console.error(e);
            }
        }
    }

    if (test) {
        return failedTests.length === 0;
    } else {
        return true;
    }
    } finally {
        if (test) {
            globalThis.removeEventListener('error', onSuiteError);
            // Mandatory: a 'load' listener's setInterval would hang the run.
            try { dispatchUnloadEvent(); } catch { /* a listener threw; not fatal */ }
        }
    }
}

interface TimerWithId {
    __cno_timer_id?: unknown;
}

function isTimerWithId(timer: unknown): timer is TimerWithId {
    return typeof timer === 'object' && timer !== null && '__cno_timer_id' in timer;
}

function getTimerID(timer: unknown): number {
    if (typeof timer === 'number')
        return timer;
    else if (isTimerWithId(timer) && typeof timer.__cno_timer_id == 'number')
        return timer.__cno_timer_id;
    else
        throw new Error('Invalid timer');
}

const uname = os.uname();
let denoExitCode = 0;

function syncProcessExitCode(value: number): void {
    const proc = Reflect.get(globalThis, 'process');
    if ((typeof proc === 'object' || typeof proc === 'function') && proc !== null) {
        Reflect.set(proc, 'exitCode', value);
    }
}

function setDenoExitCode(value: unknown): void {
    if (typeof value !== 'number') {
        throw new TypeError(`Exit code must be a number, got: ${String(value)} (${typeof value})`);
    }
    if (!Number.isInteger(value)) {
        throw new RangeError(`Exit code must be an integer, got: ${value}`);
    }
    denoExitCode = value;
    syncProcessExitCode(value);
}

Object.defineProperty(globalThis, "Deno", {
    value: {
        errors,
        get pid() {
            return os.pid;
        },
        get ppid() {
            return os.ppid;
        },
        env: {
            get: safeGetEnv,
            set: setEnv,
            has: (key: string) => safeGetEnv(key) !== undefined,
            delete: deleteEnv,
            toObject() {
                const env: Record<string, string> = Object.create(null);
                for (const key of os.envKeys()) try {
                    if (key[0] == '=') continue;    // windows cmd legacy env var
                    const value = os.getenv(key);
                    if (value !== undefined) env[key] = value;
                } catch {}
                return env;
            },
        },
        exit: (code?: number) => os.exit(code ?? denoExitCode),
        get exitCode() {
            return denoExitCode;
        },
        set exitCode(value: unknown) {
            setDenoExitCode(value);
        },
        build: createDenoBuild(uname.machine, toDenoSystemName(uname.sysname)),
        version: {
            deno: packageJson.version,
            // note: this is not real!
            v8: engine.versions.quickjs,
            typescript: "5.9.2",
        },
        cwd: () => {
            try {
                return os.cwd;
            } catch (e) {
                // A removed working directory reports ENOENT from getcwd; real
                // Deno raises NotFound for it.
                if (Reflect.get(e as object, 'code') === error.errno.ENOENT) {
                    throw new errors.NotFound('The current working directory was removed');
                }
                throw e;
            }
        },
        chdir: denoChdir,
        get mainModule() {
            // The CLI publishes the entry URL on its `cno.runtime` channel.
            return String(mainScriptUrl() ?? '');
        },
        execPath: () => os.exePath,
        noColor: safeGetEnv("NO_COLOR") ? true : false,
        memoryUsage: () => {
            const memory = os.memoryUsage();
            return {
                external: memory["vm.used"],
                // note: qjs does not have heap
                heapTotal: memory['used'],
                heapUsed: memory['used'],
                rss: memory["os.rss"],
            }
        },
        cpuUsage: () => {
            const cpus = os.cpuInfo();
            let user = 0;
            let system = 0;
            for (const cpu of cpus) {
                user += cpu.times.user + cpu.times.nice;
                system += cpu.times.sys;
            }
            return {
                user: Math.max(0, Math.round(user * 1000)),
                system: Math.max(0, Math.round(system * 1000)),
            };
        },
        systemMemoryInfo() {
            const memory = os.memoryUsage();
            return {
                total: memory["os.total"],
                free: memory["os.free"],
                available: memory["os.free"],
                // these are not supported by cjs
                buffers: 0,
                cached: 0,
                swapTotal: 0,
                swapFree: 0
            };
        },
        hostname: () => os.hostName,
        loadavg: os.loadavg,
        osRelease: () => os.uname().release,
        osUptime: () => os.uptime(),
        SeekMode: {
            Start: 0,
            Current: 1,
            End: 2,
        },

        // permission eco
        permissions: {
            query(desc: Deno.PermissionDescriptor) { return Promise.resolve(this.querySync(desc)); },
            querySync: (_desc: Deno.PermissionDescriptor) => ({
                state: 'granted',
                addEventListener: () => void 0,
                removeEventListener: () => void 0,
                dispatchEvent: () => true,
                onchange: null,
                partial: false,
            }),
            request: notSupported,
            requestSync: notSupported,
            revoke: notSupported,
            revokeSync: notSupported,
        },

        addSignalListener(sig: Deno.Signal, handler: () => void) {
            if (!signal) throw new Error('signal handling is unavailable outside the main thread');
            if (typeof handler !== 'function') throw new TypeError('Signal handler must be a function');
            const normalized = normalizeSignalName(sig);
            const sigint = signal.signals[normalized];
            if (typeof sigint != 'number')
                throw new Error(`Invalid signal: ${sig}`);
            if (signalMap[normalized]?.has(handler))
                return;
            const ret = signal.signal(sigint, handler);
            if (!signalMap[normalized]) signalMap[normalized] = new Map();
            signalMap[normalized].set(handler, ret);
        },

        removeSignalListener(sig: Deno.Signal, handler: () => void) {
            if (!signal) throw new Error('signal handling is unavailable outside the main thread');
            if (typeof handler !== 'function') throw new TypeError('Signal handler must be a function');
            const normalized = normalizeSignalName(sig);
            const sigint = signal.signals[normalized];
            if (typeof sigint != 'number')
                throw new Error(`Invalid signal: ${sig}`);
            const map = signalMap[normalized];
            if (!map) return;
            const ret = map.get(handler);
            if (!ret) return;
            ret.close();
            map.delete(handler);
            if (map.size === 0) delete signalMap[normalized];
        },

        inspect(obj: unknown, opt?: Deno.InspectOptions) {
            const inspectOptions = opt as InspectOptionsWithCustom | undefined;
            const customInspect = inspectOptions?.customInspect;
            const custom = customInspect === false
                ? undefined
                : ((typeof obj === 'object' && obj !== null) || typeof obj === 'function')
                ? (obj as CustomInspectable)[customInspectSymbol]
                : undefined;
            if (typeof custom === 'function') {
                const inspect = (value: unknown, options?: Deno.InspectOptions) =>
                    Deno.inspect(value, { ...opt, ...options });
                return String(custom.call(obj, inspect, opt ?? {}));
            }
            const realmValue = inspectRealmValue(obj);
            if (realmValue !== undefined) return realmValue;
            return console.inspect(obj, toNativeInspectOptions(opt));
        },

        refTimer(id: unknown) {
            const timerId = getTimerID(id);
            if (!timerId) return;
            timers.refTimer(timerId);
        },
        unrefTimer(id: unknown) {
            const timerId = getTimerID(id);
            if (!timerId) return;
            timers.unrefTimer(timerId);
        },

        uid() {
            // Mirrors the host user record; suid effective IDs are not exposed.
            // Windows has no uid/gid, and upstream Deno returns null there.
            const id = os.userInfo.userId;
            return id < 0 ? null : id;
        },
        gid() {
            const id = os.userInfo.groupId;
            return id < 0 ? null : id;
        },

        test: createTestFunction(),
        bench: createBenchFunction(),
        async __startTest(name = '<core>', executes: 'bench' | 'test' | 'both' = 'both') {
            let res = true;
            if (executes == 'both') res = await startTest(name, true, true);
            else res = await startTest(name, executes == 'test', executes == 'bench');
            if (!res) {
                console.log('Failed tests:');
                for (const failed of failedTests) {
                    console.error(failed.name);
                }
            }
            return res;
        },

        // ONLY FOR TEST SUITE!
        internal: kInternal,
        [kInternal]: {
            inspectArgs: (args: unknown[]) => {
                return args.map(arg => console.inspect(arg, {
                    colors: false,
                    depth: 10,
                    showHidden: false
                })).join(' ');
            },
            pathFromURL,
        },
    },
    writable: false,
    enumerable: true,
    configurable: true,
});

// delay setting args
Reflect.defineProperty(Deno, 'args', {
    get: buildDenoArgs,
    set: () => void 0,
    enumerable: true,
    configurable: true,
});

// Staged first: its exports are a requested field of this module. Docs: docs/webapi-notes.md
export const { stdin, stdout, stderr } = await import('./04_stdio');
await Promise.all([
    import('./00_permission'),
    import('./02_fs'),
    import('./03_fopen'),
    import('./07_http'),
]);

// Lazy: boot-reachable bytecode costs startup. See docs/webapi-notes.md
const netNamespace = import('./05_net').then(mod => mod.NET_EXPORTS);
const processNamespace = import('./06_process').then(mod => mod.PROCESS_EXPORTS);
const serveNamespace = import('./08_serve').then(mod => mod.SERVE_EXPORTS);
const quicNamespace: Promise<Record<string, unknown>> = import('./10_quic');
const kvNamespace: Promise<Record<string, unknown>> = import('./kv');
const ffiNamespace: Promise<Record<string, unknown>> = import('./ffi');
// Cron starts no timer until a job is added, but `Deno.cron` is probed by `typeof`
// in user code, so it keeps loading at boot.
const cronNamespace: Promise<Record<string, unknown>> = import('./09_cron');

function namespaceValues(namespace: Promise<object>, ...names: string[]): Promise<Map<string, unknown>> {
    return namespace.then((mod) => new Map(names.map(name => [name, Reflect.get(mod, name)])));
}

// Net: free functions, plus the QUIC entry points that live in their own module
// (its native gate still fails closed on listen/connect).
const NET_ENTRIES = ['connect', 'connectTls', 'listen', 'listenTls', 'startTls', 'listenDatagram', 'networkInterfaces', 'resolveDns'] as const;
const netLazy: Promise<void> = defineLazy(Deno, [
    ...NET_ENTRIES.map(name => ({ name, kind: 'fn' as const })),
    { name: 'QuicEndpoint', kind: 'ctor' as const },
    { name: 'connectQuic', kind: 'fn' as const },
], async () => {
    const [values, quic] = await Promise.all([namespaceValues(netNamespace, ...NET_ENTRIES), quicNamespace]);
    values.set('QuicEndpoint', Reflect.get(quic, 'QuicEndpoint'));
    values.set('connectQuic', Reflect.get(quic, 'connectQuic'));
    return values;
});

// Process: `umask` keeps a value between calls, so its stand-in must reach the
// module's current function instead of freezing one.
const PROCESS_ENTRIES = ['Command', 'ChildProcess', 'Process', 'kill', 'umask', 'spawn', 'spawnAndWait', 'spawnAndWaitSync'] as const;
const processLazy: Promise<void> = defineLazy(Deno, [
    { name: 'Command', kind: 'ctor' as const },
    { name: 'ChildProcess', kind: 'ctor' as const },
    { name: 'Process', kind: 'ctor' as const },
    { name: 'kill', kind: 'fn' as const },
    { name: 'umask', kind: 'fn' as const },
    { name: 'spawn', kind: 'fn' as const },
    { name: 'spawnAndWait', kind: 'fn' as const },
    { name: 'spawnAndWaitSync', kind: 'fn' as const },
], () => namespaceValues(processNamespace, ...PROCESS_ENTRIES));

// Serve: the HTTP server object is only built once a request arrives.
const serveLazy: Promise<void> = defineLazy(Deno, [
    { name: 'serve', kind: 'fn' as const },
    { name: 'upgradeWebSocket', kind: 'fn' as const },
], () => namespaceValues(serveNamespace, 'serve', 'upgradeWebSocket'));

// KV and FFI (unstable APIs): constructors plus a function apiece.
const KV_ENTRIES = ['openKv', 'Kv', 'KvListIterator', 'KvU64', 'AtomicOperation'] as const;
const kvLazy: Promise<void> = defineLazy(Deno, [
    { name: 'openKv', kind: 'fn' as const },
    { name: 'Kv', kind: 'ctor' as const },
    { name: 'KvListIterator', kind: 'ctor' as const },
    { name: 'KvU64', kind: 'ctor' as const },
    { name: 'AtomicOperation', kind: 'ctor' as const },
], () => namespaceValues(kvNamespace, ...KV_ENTRIES));

const FFI_ENTRIES = ['dlopen', 'UnsafePointer', 'UnsafePointerView', 'UnsafeCallback', 'UnsafeFnPointer'] as const;
const ffiLazy: Promise<void> = defineLazy(Deno, [
    { name: 'dlopen', kind: 'fn' as const },
    { name: 'UnsafePointer', kind: 'ctor' as const },
    { name: 'UnsafePointerView', kind: 'ctor' as const },
    { name: 'UnsafeCallback', kind: 'ctor' as const },
    { name: 'UnsafeFnPointer', kind: 'ctor' as const },
], () => namespaceValues(ffiNamespace, ...FFI_ENTRIES));

// Test harness (`__startTest`): a suite reads feature globals as soon as its file
// loads, so `startTest` evaluates every module that the eager boot used to load
// before the first test body runs. Non-test programs pay only when they read.
export const lazyModules: readonly Promise<unknown>[] = [
    netLazy, processLazy, serveLazy, kvLazy, ffiLazy, cronNamespace.then(() => undefined),
];


