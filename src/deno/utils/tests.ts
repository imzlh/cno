import { ensureDirectory } from "../../utils/fs-path";
import { basename, dirname, resolvePath, toFsPath } from "../../utils/path";
import { getEnv } from "../../utils/env";

const engine = import.meta.use('engine');
const console = import.meta.use('console');
const asyncfs = import.meta.use('asyncfs');

interface SnapshotPathOptions {
    dir?: string;
    path?: string;
}

function resolveSnapshotFile(fsPath: string, options?: SnapshotPathOptions): string {
    const baseDir = dirname(fsPath);
    if (options?.path !== undefined) {
        return resolvePath(options.path, baseDir);
    }

    const snapshotDir = options?.dir === undefined
        ? resolvePath('__snapshots__', baseDir)
        : resolvePath(options.dir, baseDir);
    return resolvePath(`${basename(fsPath)}.snap`, snapshotDir);
}

function snapshotOriginPath(origin: string): string {
    if (!origin.startsWith('file:')) return origin;
    try {
        return toFsPath(new URL(origin));
    } catch {
        return origin;
    }
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
    const dir = dirname(file);
    await ensureDirectory(dir);
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
    getEnv('DENO_SNAPSHOT_UPDATE') === '1';

async function assertSnapshotImpl<T>(
    actual: T,
    origin: string,
    testName: string,
    options?: SnapshotPathOptions & { name?: string; msg?: string; serializer?: (v: T) => string }
): Promise<void> {
    // Test origins are often logical names, not file URLs. Only URL-valued
    // filesystem arguments need URL decoding here.
    const fsPath = snapshotOriginPath(origin);
    const snapFilePath = resolveSnapshotFile(fsPath, options);
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

export const testRegistry: Deno.TestDefinition[] = [];
export const benchRegistry: Deno.BenchDefinition[] = [];
export const beforeAllHooks: (() => void | Promise<void>)[] = [];
export const beforeEachHooks: (() => void | Promise<void>)[] = [];
export const afterEachHooks: (() => void | Promise<void>)[] = [];
export const afterAllHooks: (() => void | Promise<void>)[] = [];
export const failedTests: IFailedTest[] = [];

export const toError = (e: unknown): Error =>
    e instanceof Error ? e : new Error(String(e));

export function getFailedTests(): IFailedTest[] {
    return failedTests;
}

function recordHookFailure(name: string, error: unknown): void {
    failedTests.push({
        name,
        fn: () => {},
        error: toError(error),
    });
}

export async function runTestHook(hook: () => void | Promise<void>, name: string, message: string): Promise<void> {
    try {
        await hook();
    } catch (e) {
        console.error(message, e);
        recordHookFailure(name, e);
    }
}

export function createTestContext(name: string, origin: string, parent?: Deno.TestContext): Deno.TestContext {
    const ctx: Deno.TestContext = {
        name,
        origin,
        parent,
        async assertSnapshot<T>(actual: T, options?: {
            name?: string; dir?: string; path?: string; msg?: string; serializer?: (v: T) => string;
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

export function createBenchContext(name: string, origin: string): Deno.BenchContext {
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

export function filterMatches(name: string, filter: string | RegExp | undefined): boolean {
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

export function createTestFunction(): Deno.DenoTest {
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

export function createBenchFunction(): BenchFunction {
    const benchFn: BenchFunction = (...args: unknown[]) => {
        registerBench(parseBenchArgs(args));
    };

    return benchFn;
}
