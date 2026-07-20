import packageJson from '../../package.json';
import { buildDenoArgs } from "../utils/args";
import { wrapFSErr } from "../utils/wrap";
import { errors } from "./01_errors";

const os = import.meta.use('os');
const engine = import.meta.use('engine');
const signal = import.meta.use('signals');
const console = import.meta.use('console');
const timers = import.meta.use('timers');
const asyncfs = import.meta.use('asyncfs');

const kInternal = Symbol('Deno.internal');

// ─── Snapshot helpers ────────────────────────────────────────────────────────

async function mkdirQuietly(path: string): Promise<void> {
    try {
        await asyncfs.mkdir(path);
    } catch {
        // If the directory still cannot be used, opening the snapshot file fails.
    }
}

function urlToFsPath(url: string): string {
    if (url.startsWith('file:///')) {
        const raw = url.slice(7); // keep leading '/'
        // On Windows: file:///C:/path → /C:/path → C:/path
        if (/^\/[A-Za-z]:\//.test(raw)) return raw.slice(1).replace(/\//g, '\\');
        return decodeURIComponent(raw);
    }
    return url;
}

function pathFromStringOrUrl(path: string | URL): string {
    if (!(path instanceof URL)) return path;
    if (path.protocol !== 'file:') throw new TypeError('Expected a file URL');
    return urlToFsPath(path.href);
}

function pathFromURL(url: URL): string {
    if (!(url instanceof URL)) throw new TypeError('Expected a URL');
    if (url.protocol !== 'file:') throw new TypeError('Expected a file URL');
    return urlToFsPath(url.href);
}

function rethrowDenoFsError(error: unknown): never {
    throw wrapFSErr(error);
}

function denoCwd(): string {
    try {
        return os.cwd;
    } catch (error) {
        rethrowDenoFsError(error);
    }
}

function denoChdir(dir: string | URL): void {
    try {
        os.chdir(pathFromStringOrUrl(dir));
    } catch (error) {
        rethrowDenoFsError(error);
    }
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
    await mkdirQuietly(dir);
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
    Reflect.get(globalThis, '__cts_update_snapshots') === true ||
    safeGetEnv('DENO_SNAPSHOT_UPDATE') === '1';

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

    const expected = map.get(key);
    if (expected === undefined) throw new Error(`Snapshot "${key}" is missing.`);
    if (serialized !== expected) {
        const msg = options?.msg ?? `Snapshot "${key}" mismatch.\n  actual:   ${serialized}\n  expected: ${expected}`;
        throw new Error(msg);
    }
}

// ─── Printf-style name formatting for each() ─────────────────────────────────

function formatEachName(template: string, args: readonly unknown[]): string {
    // Object-style: $key substitution when there is one object argument
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
        const obj = args[0];
        return template.replace(/\$([a-zA-Z_]\w*)/g, (_, k) => String(Reflect.get(obj, k) ?? `$${k}`));
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
    const key = toEnvKey(env);
    try {
        return os.getenv(key) ?? undefined;
    } catch {
        return undefined;
    }
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

type EachCaseArgs<T> = T extends readonly unknown[] ? T : readonly [T];

function eachCaseArgs<T>(args: T): EachCaseArgs<T> {
    return (Array.isArray(args) ? args : [args]) as EachCaseArgs<T>;
}

export interface IFailedTest extends Deno.TestDefinition {
    error: Error;
}

export interface StartTestOptions {
    filter?: string | RegExp;
    failFast?: boolean;
}

const testRegistry: Deno.TestDefinition[] = [];
const benchRegistry: Deno.BenchDefinition[] = [];
const beforeAllHooks: (() => void | Promise<void>)[] = [];
const beforeEachHooks: (() => void | Promise<void>)[] = [];
const afterEachHooks: (() => void | Promise<void>)[] = [];
const afterAllHooks: (() => void | Promise<void>)[] = [];
const failedTests: IFailedTest[] = [];

type TestDefinitionWithNoRun = Deno.TestDefinition & { noRun?: boolean };

const toError = (e: unknown): Error =>
    e instanceof Error ? e : new Error(String(e));

function recordHookFailure(name: string, error: unknown): void {
    failedTests.push({
        name,
        fn: () => {},
        error: toError(error),
    });
}

async function runTestHook(hook: () => void | Promise<void>, name: string, message: string): Promise<void> {
    try {
        await hook();
    } catch (e) {
        console.error(message, e);
        recordHookFailure(name, e);
    }
}

function createTestContext(name: string, origin: string, parent?: Deno.TestContext): Deno.TestContext {
    const ctx: Deno.TestContext = {
        name,
        origin,
        parent,
        async assertSnapshot<T>(actual: T, options?: {
            name?: string; dir?: string; msg?: string; serializer?: (v: T) => string;
        } | string): Promise<void> {
            const snapshotOptions = typeof options === 'string' ? { msg: options } : options;
            await assertSnapshotImpl(actual, origin, name, snapshotOptions);
        },
        async step(definitionOrName: Deno.TestStepDefinition | string | ((t: Deno.TestContext) => void | Promise<void>), fn?: (t: Deno.TestContext) => void | Promise<void>): Promise<boolean> {
            let stepDef: Deno.TestStepDefinition;

            if (typeof definitionOrName === 'string') {
                if (typeof fn !== 'function') throw new TypeError('Expected function for second argument');
                stepDef = { name: definitionOrName, fn };
            } else if (typeof definitionOrName === 'function') {
                if (!definitionOrName.name) throw new TypeError('The step function must have a name');
                const funcName = definitionOrName.name;
                stepDef = { name: funcName, fn: definitionOrName };
            } else if (typeof definitionOrName === 'object' && definitionOrName !== null) {
                stepDef = definitionOrName;
                if (typeof stepDef.fn !== 'function') throw new TypeError('Expected function for second argument');
            } else {
                throw new TypeError('Expected a test definition or name and function');
            }

            if (!stepDef.name) throw new TypeError("The test name can't be empty");

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

function filterMatches(name: string, filter: string | RegExp | undefined): boolean {
    if (filter === undefined) return true;
    if (filter instanceof RegExp) return filter.test(name);
    if (filter.startsWith('/') && filter.lastIndexOf('/') > 0) {
        const end = filter.lastIndexOf('/');
        try {
            return new RegExp(filter.slice(1, end), filter.slice(end + 1)).test(name);
        } catch {
            // Invalid regex filters are treated as plain substrings.
        }
    }
    return name.includes(filter);
}

type TestFn = Deno.TestDefinition['fn'];
type BenchFn = Deno.BenchDefinition['fn'];
type TestOptions = Partial<Omit<Deno.TestDefinition, 'fn' | 'name'>> & {
    name?: string;
    fn?: TestFn;
};
type BenchOptions = Partial<Omit<Deno.BenchDefinition, 'fn' | 'name'>> & {
    name?: string;
    fn?: BenchFn;
};

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return typeof value === 'object' && value !== null;
}

function isTestFn(value: unknown): value is TestFn {
    return typeof value === 'function';
}

function isBenchFn(value: unknown): value is BenchFn {
    return typeof value === 'function';
}

function isBenchDefinition(obj: unknown): obj is Deno.BenchDefinition {
    return isRecord(obj) && typeof obj.name === 'string' && isBenchFn(obj.fn);
}

function testOptions(obj: unknown): TestOptions {
    if (!isRecord(obj)) throw new TypeError('Invalid test definition');
    return obj as TestOptions;
}

function benchOptions(obj: unknown): BenchOptions {
    if (!isRecord(obj)) throw new TypeError('Invalid bench definition');
    return obj as BenchOptions;
}

function parseTestArgs(args: unknown[], extra?: Partial<Deno.TestDefinition>): Deno.TestDefinition {
    const hasOwn = (obj: unknown, key: PropertyKey): boolean =>
        isRecord(obj) && Object.prototype.hasOwnProperty.call(obj, key);
    const ensureName = (name: string): string => {
        if (name.length === 0) throw new TypeError("The test name can't be empty");
        return name;
    };
    const functionName = (fn: TestFn): string => {
        if (!fn.name) throw new TypeError('The test function must have a name');
        return fn.name;
    };

    if (args.length === 1) {
        const arg = args[0];
        if (isTestFn(arg)) return { name: functionName(arg), fn: arg, ...extra };
        if (isRecord(arg)) {
            const opts = testOptions(arg);
            if (!isTestFn(opts.fn)) throw new TypeError("Expected 'fn' field in the first argument to be a test function");
            const name = opts.name ?? functionName(opts.fn);
            return { ...opts, name: ensureName(name), fn: opts.fn, ...extra };
        }
        throw new TypeError('Invalid test definition');
    } else if (args.length === 2) {
        const [a, b] = args;
        if (typeof a === 'string' && isTestFn(b))
            return { name: ensureName(a), fn: b, ...extra };
        if (isTestFn(a) && isRecord(b)) {
            throw new TypeError('Unexpected second argument to Deno.test()');
        }
        if (isRecord(a) && isTestFn(b)) {
            if (hasOwn(a, 'fn')) {
                throw new TypeError("Unexpected 'fn' field in options, test function is already provided as the second argument");
            }
            const { name, fn: _optionFn, ...opts } = testOptions(a);
            return { name: ensureName(name ?? functionName(b)), fn: b, ...opts, ...extra };
        }
        throw new TypeError('Invalid test definition');
    } else if (args.length === 3) {
        const [nameArg, optionsArg, fnArg] = args;
        if (!isTestFn(fnArg)) throw new TypeError('Invalid test definition');
        if (hasOwn(optionsArg, 'fn')) {
            throw new TypeError("Unexpected 'fn' field in options, test function is already provided as the third argument");
        }
        if (hasOwn(optionsArg, 'name')) {
            throw new TypeError("Unexpected 'name' field in options, test name is already provided as the first argument");
        }
        const { name: _name, fn: _fn, ...opts } = testOptions(optionsArg);
        if (typeof nameArg !== 'string') throw new TypeError('Invalid test definition');
        return { name: ensureName(nameArg), fn: fnArg, ...opts, ...extra };
    }
    throw new TypeError('Invalid test definition');
}

function parseBenchArgs(args: unknown[]): Deno.BenchDefinition {
    if (args.length === 1) {
        const arg = args[0];
        if (isBenchDefinition(arg)) return { ...arg };
        if (isBenchFn(arg)) return { name: arg.name || 'anonymous', fn: arg };
        throw new TypeError('Invalid bench definition');
    } else if (args.length === 2) {
        const [a, b] = args;
        if (typeof a === 'string' && isBenchFn(b)) return { name: a, fn: b };
        if (isRecord(a) && isBenchFn(b)) {
            const { name, fn: _fn, ...opts } = benchOptions(a);
            return { name: name ?? (b.name || 'anonymous'), fn: b, ...opts };
        }
        throw new TypeError('Invalid bench definition');
    } else if (args.length === 3) {
        const [nameArg, optionsArg, fnArg] = args;
        if (!isBenchFn(fnArg)) throw new TypeError('Invalid bench definition');
        const { name, fn: _fn, ...opts } = benchOptions(optionsArg);
        return { name: typeof nameArg === 'string' ? nameArg : name ?? fnArg.name ?? 'anonymous', fn: fnArg, ...opts };
    }
    throw new TypeError('Invalid bench definition');
}

function createTestFunction(): Deno.DenoTest {
    const testFn = ((...args: unknown[]) => registerTest(parseTestArgs(args))) as Deno.DenoTest;
    const testObj = Object.assign(testFn, {
        ignore: (...args: unknown[]) => registerTest(parseTestArgs(args, { ignore: true })),
        only:    (...args: unknown[]) => registerTest(parseTestArgs(args, { only: true })),
        beforeAll:   (fn: () => void | Promise<void>) => { beforeAllHooks.push(fn); },
        beforeEach:  (fn: () => void | Promise<void>) => { beforeEachHooks.push(fn); },
        afterEach:   (fn: () => void | Promise<void>) => { afterEachHooks.push(fn); },
        afterAll:    (fn: () => void | Promise<void>) => { afterAllHooks.push(fn); },
        each<T>(cases: ReadonlyArray<T>) {
            return (
                name: string,
                fn: (...args: [...EachCaseArgs<T>, Deno.TestContext]) => void | Promise<void>,
                options?: Omit<Deno.TestDefinition, 'fn' | 'name'>
            ) => {
                for (const args of cases) {
                    const caseArgs = eachCaseArgs(args);
                    const caseName = formatEachName(name, caseArgs);
                    registerTest({
                        name: caseName,
                        fn: (t: Deno.TestContext) => fn(...caseArgs, t),
                        ...options,
                    });
                }
            };
        },
        sanitizer: () => { /* Test sanitizer options are accepted for compatibility. */ },
    });

    return testObj;
}

type BenchFunction = {
    (b: Deno.BenchDefinition): void;
    (name: string, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (name: string, options: Omit<Deno.BenchDefinition, "fn" | "name">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (options: Omit<Deno.BenchDefinition, "fn">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (options: Omit<Deno.BenchDefinition, "fn" | "name">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
};

function createBenchFunction(): BenchFunction {
    const benchFn: BenchFunction = (...args: unknown[]) => {
        registerBench(parseBenchArgs(args));
    };

    return benchFn;
}

export async function startTest(contextName = '<core>', test = true, bench = true, options: StartTestOptions = {}) {
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
        try { globalThis.addEventListener('error', onSuiteError); } catch { /* */ }
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
            try { globalThis.removeEventListener('error', onSuiteError); } catch { /* */ }
        }
    }
}

export function getFailedTests(): IFailedTest[] {
    return failedTests;
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
        pid: os.pid,
        ppid: os.ppid,
        env: {
            get: safeGetEnv,
            set: setEnv,
            has: (key: string) => safeGetEnv(key) !== undefined,
            delete: deleteEnv,
            toObject() {
                const env: Record<string, string> = Object.create(null);
                for (const key of os.envKeys()) {
                    const value = safeGetEnv(key);
                    if (value !== undefined) env[key] = value;
                }
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
            typescript: "5.9.2",
        },
        cwd: denoCwd,
        chdir: denoChdir,
        get mainModule() {
            return String(Reflect.get(globalThis, '__mainScript') ?? '');
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

// then import polyfills
await import('./00_permission');
await import('./02_fs');
await import('./03_fopen');
export const { stdin, stdout, stderr } = await import('./04_stdio');
await import('./05_net');
await import('./06_process');
await import('./07_http');
await import('./08_serve');
await import('./09_cron');
// QUIC — loads always; native gate fails closed on listen/connect
await import('./10_quic');

// unstable APIs
await import('./kv');
await import('./ffi');
