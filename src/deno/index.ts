import packageJson from '../../package.json';
import { buildDenoArgs } from "../utils/args";
import { errors } from "./01_errors";

const os = import.meta.use('os');
const engine = import.meta.use('engine');
const signal = import.meta.use('signals');
const console = import.meta.use('console');
const timers = import.meta.use('timers');
const asyncfs = import.meta.use('asyncfs');

const kInternal = Symbol('Deno.internal');

// ─── Snapshot helpers ────────────────────────────────────────────────────────

function urlToFsPath(url: string): string {
    if (url.startsWith('file:///')) {
        const raw = url.slice(7); // keep leading '/'
        // On Windows: file:///C:/path → /C:/path → C:/path
        if (/^\/[A-Za-z]:\//.test(raw)) return raw.slice(1).replace(/\//g, '\\');
        return raw;
    }
    return url;
}

function snapshotDir(fsPath: string, overrideDir?: string): string {
    if (overrideDir) return overrideDir;
    const sep = fsPath.includes('\\') ? '\\' : '/';
    const lastSep = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
    const dir = lastSep < 0 ? '.' : fsPath.slice(0, lastSep);
    return dir + sep + '__snapshots__';
}

function snapshotFile(fsPath: string, overrideDir?: string): string {
    const dir = snapshotDir(fsPath, overrideDir);
    const sep = dir.includes('\\') ? '\\' : '/';
    const lastSep = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
    const base = lastSep < 0 ? fsPath : fsPath.slice(lastSep + 1);
    return dir + sep + base + '.snap';
}

// Per-file snapshot data: file path → { key → value }
const snapCache = new Map<string, Map<string, string>>();

async function loadSnapshots(file: string): Promise<Map<string, string>> {
    const cached = snapCache.get(file);
    if (cached) return cached;
    const map = new Map<string, string>();
    try {
        const buf = await asyncfs.readFile(file);
        const text = engine.decodeString(buf);
        // Parse lines: each entry is   [key]\n<value>\n---
        const blocks = text.split('\n---\n');
        for (const block of blocks) {
            const nl = block.indexOf('\n');
            if (nl < 0) continue;
            const header = block.slice(0, nl).trim();
            if (!header.startsWith('[') || !header.endsWith(']')) continue;
            const key = header.slice(1, -1);
            map.set(key, block.slice(nl + 1));
        }
    } catch {
        // File doesn't exist yet — start empty
    }
    snapCache.set(file, map);
    return map;
}

async function saveSnapshots(file: string, map: Map<string, string>): Promise<void> {
    const dir = snapshotDir(file);
    try { await asyncfs.mkdir(dir); } catch { }
    const parts: string[] = [];
    for (const [key, value] of map) {
        parts.push(`[${key}]\n${value}\n---`);
    }
    const text = parts.join('\n');
    const fp = await asyncfs.open(file, 'w');
    await fp.write(engine.encodeString(text));
    fp.close();
}

// Counter per (snapFile, testName) to auto-number successive assertSnapshot calls
const snapCounters = new Map<string, number>();

const updateSnapshots =
    (globalThis as any).__cts_update_snapshots === true ||
    (typeof os.getenv === 'function' && os.getenv('DENO_SNAPSHOT_UPDATE') === '1');

async function assertSnapshotImpl<T>(
    actual: T,
    origin: string,
    testName: string,
    options?: { name?: string; dir?: string; msg?: string; serializer?: (v: T) => string }
): Promise<void> {
    const fsPath = urlToFsPath(origin);
    const snapFilePath = snapshotFile(fsPath, options?.dir);
    const serialized = options?.serializer ? options.serializer(actual) : console.inspect(actual, { colors: false, depth: 10 });

    const counterKey = `${snapFilePath}\0${testName}`;
    const idx = (snapCounters.get(counterKey) ?? 0) + 1;
    snapCounters.set(counterKey, idx);
    const key = options?.name ?? `${testName} ${idx}`;

    const map = await loadSnapshots(snapFilePath);

    if (updateSnapshots || !map.has(key)) {
        map.set(key, serialized);
        await saveSnapshots(snapFilePath, map);
        if (!updateSnapshots) console.log(`  snapshot created: ${key}`);
        return;
    }

    const expected = map.get(key)!;
    if (serialized !== expected) {
        const msg = options?.msg ?? `Snapshot "${key}" mismatch.\n  actual:   ${serialized}\n  expected: ${expected}`;
        throw new Error(msg);
    }
}

// ─── Printf-style name formatting for each() ─────────────────────────────────

function formatEachName(template: string, args: unknown[]): string {
    // Object-style: $key substitution when there is one object argument
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
        const obj = args[0] as Record<string, unknown>;
        return template.replace(/\$([a-zA-Z_]\w*)/g, (_, k) => String(obj[k] ?? `$${k}`));
    }
    // printf-style
    let idx = 0;
    return template.replace(/%([dsifoO%])/g, (_, fmt) => {
        if (fmt === '%') return '%';
        const arg = args[idx++];
        switch (fmt) {
            case 'd': case 'i': return String(Math.trunc(Number(arg)));
            case 's': return String(arg);
            case 'f': return String(Number(arg));
            case 'o': case 'O': return console.inspect(arg, { colors: false });
            default: return String(arg);
        }
    });
}

// ─── Registry and helper types ────────────────────────────────────────────────

function notSupported(): never {
    throw new errors.NotSupported("Not supported");
}

function toDenoSystemName(name: string): string {
    if (name.includes('MINGW') || name == 'Windows_NT') return 'windows';
    if (name == 'macOS') return 'darwin';
    return 'linux';
}

/** Map uname.machine + toDenoSystemName to a standard Rust-style target triple. */
function toDenoTarget(arch: string, os: string): string {
    const a = arch === 'x86_64' || arch === 'x64' ? 'x86_64'
            : arch === 'aarch64' || arch === 'arm64' ? 'aarch64'
            : arch;
    if (os === 'windows') return `${a}-pc-windows-msvc`;
    if (os === 'darwin')   return `${a}-apple-darwin`;
    return `${a}-unknown-linux-gnu`;
}

const signalMap: Record<string, Map<() => void, CModuleSignals.SignalHandler>> = {};

function safeGetEnv(env: string) {
    try {
        return os.getenv(env);
    } catch { }
}

export interface IFailedTest extends Deno.TestDefinition {
    error: Error;
}

const testRegistry: Deno.TestDefinition[] = [];
const benchRegistry: Deno.BenchDefinition[] = [];
const beforeAllHooks: (() => void | Promise<void>)[] = [];
const beforeEachHooks: (() => void | Promise<void>)[] = [];
const afterEachHooks: (() => void | Promise<void>)[] = [];
const afterAllHooks: (() => void | Promise<void>)[] = [];
const failedTests: IFailedTest[] = [];

const toError = (e: unknown): Error =>
    e instanceof Error ? e : new Error(String(e));
function createTestContext(name: string, origin: string, parent?: Deno.TestContext): Deno.TestContext {
    const ctx: Deno.TestContext = {
        name,
        origin,
        parent,
        async assertSnapshot<T>(actual: T, options?: {
            name?: string; dir?: string; msg?: string; serializer?: (v: T) => string;
        }): Promise<void> {
            await assertSnapshotImpl(actual, origin, name, options);
        },
        async step(definitionOrName: Deno.TestStepDefinition | string | ((t: Deno.TestContext) => void | Promise<void>), fn?: (t: Deno.TestContext) => void | Promise<void>): Promise<boolean> {
            let stepDef: Deno.TestStepDefinition;

            if (typeof definitionOrName === 'string') {
                stepDef = { name: definitionOrName, fn: fn! };
            } else if (typeof definitionOrName === 'function') {
                const funcName = definitionOrName.name || 'anonymous step';
                stepDef = { name: funcName, fn: definitionOrName };
            } else {
                stepDef = definitionOrName;
            }

            if (stepDef.ignore) {
                console.warn(`  skip ${stepDef.name}`);
                return false;
            }

            const stepCtx = createTestContext(stepDef.name, origin, ctx);
            try {
                await stepDef.fn(stepCtx);
                console.info(`  ok ${stepDef.name}`);
                return true;
            } catch (e) {
                console.error(`  fail ${stepDef.name}`, e);
                failedTests.push({
                    ...stepDef,
                    error: toError(e)
                });
                return false;
            }
        }
    };
    return ctx;
}

function createBenchContext(name: string, origin: string): Deno.BenchContext {
    let startTime = 0;
    let timerActive = false;

    return {
        name,
        origin,
        start() {
            startTime = performance.now();
            timerActive = true;
        },
        end() {
            if (timerActive) {
                timerActive = false;
                const elapsed = performance.now() - startTime;
                console.log(`bench ${name}: ${elapsed.toFixed(3)}ms`);
            }
        }
    };
}

function registerTest(def: Deno.TestDefinition): void {
    testRegistry.push(def);
}

function registerBench(def: Deno.BenchDefinition): void {
    benchRegistry.push(def);
}

function isDefinition(obj: unknown): obj is Deno.TestDefinition {
    return typeof obj === 'object' && obj !== null && 'fn' in obj && 'name' in obj;
}

function parseTestArgs(args: unknown[], extra?: Partial<Deno.TestDefinition>): Deno.TestDefinition {
    if (args.length === 1) {
        const arg = args[0];
        if (typeof arg === 'object' && arg !== null && 'fn' in arg && 'name' in arg) return { ...arg, ...extra } as Deno.TestDefinition;
        if (typeof arg === 'function') return { name: arg.name || 'anonymous', fn: arg as any, ...extra };
        throw new TypeError('Invalid test definition');
    } else if (args.length === 2) {
        const [a, b] = args;
        if (typeof a === 'string') return { name: a, fn: b as any, ...extra };
        if (typeof a === 'object' && typeof b === 'function') {
            const { name: _n, fn: _f, ...opts } = a as any;
            return { name: (b as any).name || 'anonymous', fn: b as any, ...opts, ...extra };
        }
        throw new TypeError('Invalid test definition');
    } else if (args.length === 3) {
        const { name: _n, fn: _f, ...opts } = args[1] as any;
        return { name: args[0] as string, fn: args[2] as any, ...opts, ...extra };
    }
    throw new TypeError('Invalid test definition');
}

function parseBenchArgs(args: unknown[]): Deno.BenchDefinition {
    if (args.length === 1) {
        const arg = args[0];
        if (isDefinition(arg)) return { name: (arg as any).name, fn: (arg as any).fn, ...(arg as any) };
        if (typeof arg === 'function') return { name: arg.name || 'anonymous', fn: arg as any };
        throw new TypeError('Invalid bench definition');
    } else if (args.length === 2) {
        const [a, b] = args;
        if (typeof a === 'string') return { name: a, fn: b as any };
        if (typeof a === 'object' && typeof b === 'function') {
            const { name: _n, fn: _f, ...opts } = a as any;
            return { name: (b as any).name || 'anonymous', fn: b as any, ...opts };
        }
        throw new TypeError('Invalid bench definition');
    } else if (args.length === 3) {
        const { name: _n, fn: _f, ...opts } = args[1] as any;
        return { name: args[0] as string, fn: args[2] as any, ...opts };
    }
    throw new TypeError('Invalid bench definition');
}

function createTestFunction(): Deno.DenoTest {
    const testFn = (...args: unknown[]) => registerTest(parseTestArgs(args));
    const testObj = Object.assign(testFn, {
        ignore: (...args: unknown[]) => registerTest(parseTestArgs(args, { ignore: true })),
        only:    (...args: unknown[]) => registerTest(parseTestArgs(args, { only: true })),
        beforeAll:   (fn: () => void | Promise<void>) => { beforeAllHooks.push(fn); },
        beforeEach:  (fn: () => void | Promise<void>) => { beforeEachHooks.push(fn); },
        afterEach:   (fn: () => void | Promise<void>) => { afterEachHooks.push(fn); },
        afterAll:    (fn: () => void | Promise<void>) => { afterAllHooks.push(fn); },
        each<T extends readonly unknown[]>(cases: ReadonlyArray<T>) {
            return (
                name: string,
                fn: (...args: any[]) => void | Promise<void>,
                options?: Omit<Deno.TestDefinition, 'fn' | 'name'>
            ) => {
                for (const args of cases) {
                    const caseArgs: unknown[] = Array.isArray(args) ? args : [args];
                    const caseName = formatEachName(name, caseArgs);
                    registerTest({
                        name: caseName,
                        fn: (t: Deno.TestContext) => (fn as any)(...caseArgs, t),
                        ...options,
                    });
                }
            };
        },
        sanitizer: () => { /* no-op: sanitizers not implemented */ },
    });

    return testObj as Deno.DenoTest;
}

function createBenchFunction(): {
    (b: Deno.BenchDefinition): void;
    (name: string, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (name: string, options: Omit<Deno.BenchDefinition, "fn" | "name">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (options: Omit<Deno.BenchDefinition, "fn">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (options: Omit<Deno.BenchDefinition, "fn" | "name">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
} {
    const benchFn = (...args: unknown[]) => {
        registerBench(parseBenchArgs(args));
    };

    return benchFn as {
        (b: Deno.BenchDefinition): void;
        (name: string, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
        (fn: (b: Deno.BenchContext) => void | Promise<void>): void;
        (name: string, options: Omit<Deno.BenchDefinition, "fn" | "name">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
        (options: Omit<Deno.BenchDefinition, "fn">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
        (options: Omit<Deno.BenchDefinition, "fn" | "name">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    };
}

export async function startTest(contextName = '<core>', test = true, bench = true) {
    if (test) {
        // Run beforeAll hooks
        for (const hook of beforeAllHooks) {
            try { await hook(); } catch (e) { console.error('beforeAll hook failed', e); }
        }

        const hasOnly = testRegistry.some(t => t.only);

        for (const testItem of testRegistry) {
            if (hasOnly && !testItem.only) continue;
            if (testItem.ignore) {
                console.warn(`  skip ${testItem.name}`);
                continue;
            }

            const repeats: number = (testItem as any).repeats ?? 0;
            const retryCount: number = (testItem as any).retry ?? 0;
            const totalRuns = repeats + 1;

            for (let run = 0; run < totalRuns; run++) {
                const runLabel = totalRuns > 1 ? `${testItem.name} (${run + 1}/${totalRuns})` : testItem.name;

                // beforeEach hooks
                for (const hook of beforeEachHooks) {
                    try { await hook(); } catch (e) { console.error(`beforeEach hook failed for ${runLabel}`, e); }
                }

                let lastError: unknown;
                let success = false;

                for (let attempt = 0; attempt <= retryCount; attempt++) {
                    const stepCtx = createTestContext(runLabel, contextName);
                    try {
                        if (testItem.timeout && testItem.timeout > 0) {
                            await Promise.race([
                                testItem.fn(stepCtx),
                                new Promise<never>((_, reject) =>
                                    timers.setTimeout(() => reject(new Error(`Test timed out after ${testItem.timeout}ms`)), testItem.timeout!)
                                ),
                            ]);
                        } else {
                            await testItem.fn(stepCtx);
                        }
                        success = true;
                        break;
                    } catch (e) {
                        lastError = e;
                        if (attempt < retryCount) {
                            console.warn(`  retry ${runLabel} (attempt ${attempt + 2}/${retryCount + 1})`);
                        }
                    }
                }

                if (success) {
                    console.info(`  ok ${runLabel}`);
                } else {
                    console.error(`  fail ${runLabel}`, lastError);
                    failedTests.push({ ...testItem, name: runLabel, error: toError(lastError) });
                }

                // afterEach hooks
                for (const hook of afterEachHooks) {
                    try { await hook(); } catch (e) { console.error(`afterEach hook failed for ${runLabel}`, e); }
                }
            }
        }

        // Run afterAll hooks
        for (const hook of afterAllHooks) {
            try { await hook(); } catch (e) { console.error('afterAll hook failed', e); }
        }
    }

    if (bench) {
        const bctx = createBenchContext('main', contextName);
        bctx.start();
        for (const benchItem of benchRegistry) try {
            await benchItem.fn(bctx);
        } catch (e) {
            console.error(`  fail ${benchItem.name}`);
            console.error(e);
        }
        bctx.end();
    }

    if (test) {
        return failedTests.length === 0;
    } else {
        return true;
    }
}

export function getFailedTests(): IFailedTest[] { 
    return failedTests;
}

function getTimerID(timer: any): number {
    if (typeof timer === 'number')
        return timer;
    else if (typeof timer == 'object' && typeof timer.__cno_timer_id == 'number')
        return timer.__cno_timer_id;
    else
        throw new Error('Invalid timer');
}

const uname = os.uname();
Object.defineProperty(globalThis, "Deno", {
    value: {
        errors,
        pid: os.pid,
        ppid: os.ppid,
        env: {
            get: safeGetEnv,
            set: os.setenv,
            has: (key: string) => safeGetEnv(key) !== undefined,
            delete: (key: string) => os.unsetenv(key),
            toObject() {
                const env = {} as Record<string, string>;
                for (const key of os.envKeys()) {
                    env[key] = os.getenv(key)!;
                }
                return env;
            },
        },
        exit: code => os.exit(code ?? Deno.exitCode),
        exitCode: 0,
        build: {
            arch: uname.machine,
            os: toDenoSystemName(uname.sysname),
            standalone: false,
            target: toDenoTarget(uname.machine, toDenoSystemName(uname.sysname)),
            vendor: "cno"
        },
        version: {
            deno: packageJson.version,
            // note: this is not real!
            v8: engine.versions.quickjs,
            typescript: "5.9.0-sucrase",
        },
        cwd: () => os.cwd,
        chdir: (dir: string) => os.chdir(dir),
        get mainModule() {
            // @ts-ignore - cts api
            return globalThis.__mainScript;
        },
        execPath: () => os.exePath,
        noColor: safeGetEnv("NO_COLOR") != null,
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

        // permission eco
        permissions: {
            query(desc) { return Promise.resolve(this.querySync(desc)); },
            querySync: desc => ({
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

        addSignalListener(sig, handler) {
            // @ts-ignore
            const sigint = signal.signals[sig];
            if (typeof sigint != 'number')
                throw new Error(`Invalid signal: ${sig}`);
            if (signalMap[sig]?.has(handler))
                return;
            const ret = signal.signal(sigint, handler);
            if (!signalMap[sig]) signalMap[sig] = new Map();
            signalMap[sig].set(handler, ret);
        },

        removeSignalListener(sig, handler) {
            // @ts-ignore
            const sigint = signal.signals[sig];
            if (typeof sigint != 'number')
                throw new Error(`Invalid signal: ${sig}`);
            const map = signalMap[sig];
            if (!map) return;
            const ret = map.get(handler);
            if (ret) ret.close();
        },

        inspect(obj: any, opt) {
            return console.inspect(obj, {
                colors: opt?.colors ?? Deno.noColor,
                depth: opt?.depth ?? undefined,
                showHidden: opt?.showHidden ?? false
            });
        },

        refTimer(id) {
            timers.refTimer(getTimerID(id));
        },
        unrefTimer(id) {
            timers.unrefTimer(getTimerID(id));
        },

        uid() {
            // fixme: this is not work well when suid
            return os.userInfo.userId;
        },
        gid() {
            return os.userInfo.groupId;
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
            inspectArgs: (args: any[]) => {
                return args.map(arg => console.inspect(arg, {
                    colors: false,
                    depth: 10,
                    showHidden: false
                })).join(' ');
            },
        },
    } as Partial<typeof Deno>,
    writable: false,
    enumerable: true,
    configurable: true,
});

// delay setting args
Reflect.defineProperty(Deno, 'args', { get: buildDenoArgs });

// then import polyfills
await import('./02_fs');
await import('./03_fopen');
export const { stdin, stdout, stderr } = await import('./04_stdio');
await import('./05_net');
await import('./06_process');
await import('./07_http');
await import('./08_serve');
await import('./09_cron');
// await import('./10_quic');

// unstable APIs
await import('./kv');
await import('./ffi');