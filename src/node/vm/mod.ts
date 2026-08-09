/**
 * Node.js vm module
 * Uses engine.Sandbox and mirrors a host context object in and out.
 *
 * NOT A SECURITY BOUNDARY — the same stance Node's own documentation takes, and
 * here the gap is wider than Node's. Measured against this runtime:
 *
 *   - `Date.constructor('return globalThis')()` inside a context returns the
 *     HOST global object, from which `process` and everything else is reachable
 *     (OBSERVED). Every intrinsic in CONTEXT_GLOBAL_KEYS is the host's own
 *     object, and each one carries the host `Function` on its `constructor`.
 *   - Writing to `Date.prototype` / `Map.prototype` inside a context changes
 *     those methods for the host (OBSERVED).
 *   - `options.timeout` is accepted and never fires: an infinite loop in a
 *     context is unkillable and wedges the process (OBSERVED). QuickJS's
 *     JS_SetInterruptHandler is not wired up anywhere in circu.js/src.
 *
 * Only the first two are even partly addressable from TypeScript, and neither is
 * addressed here — see CONTEXT_GLOBAL_KEYS for why. Use a worker or a process
 * for untrusted code; treat `vm` as an isolation convenience for trusted code.
 */

const engine = import.meta.use('engine');
type VmCallable = (...args: unknown[]) => unknown;

export interface Context {
    [key: string]: unknown;
}

export interface RunningScriptOptions {
    filename?: string;
    lineOffset?: number;
    columnOffset?: number;
    cachedData?: Buffer;
    produceCachedData?: boolean;
    importModuleDynamically?: VmCallable;
    timeout?: number;
    breakOnSigint?: boolean;
    displayErrors?: boolean;
}

export interface ScriptOptions extends RunningScriptOptions {
    contextExtensions?: object[];
}

export interface CreateContextOptions {
    name?: string;
    origin?: string;
    codeGeneration?: { strings?: boolean; wasm?: boolean };
    microtaskMode?: 'afterEvaluate';
}

/** vm.constants; DONT_CONTEXTIFY marks a context that shares the caller's globals. */
export const constants = Object.freeze({
    USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('vm_dynamic_import_main_context_default'),
    DONT_CONTEXTIFY: Symbol('vm_context_no_contextify'),
});

const COMPILE_FLAGS = engine.EVAL_GLOBAL | engine.EVAL_COMPILE_ONLY;

function typeName(value: unknown): string {
    if (value === null) return 'null';
    return Array.isArray(value) ? 'an instance of Array' : typeof value;
}

function invalidArgType(name: string, expected: string, value: unknown): TypeError {
    const error = new TypeError(`The "${name}" property must be of type ${expected}. Received ${typeName(value)}`);
    Reflect.set(error, 'code', 'ERR_INVALID_ARG_TYPE');
    return error;
}

function outOfRange(name: string, range: string, value: unknown): RangeError {
    const error = new RangeError(`The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`);
    Reflect.set(error, 'code', 'ERR_OUT_OF_RANGE');
    return error;
}

function invalidArgValue(name: string, value: unknown, reason: string): TypeError {
    const error = new TypeError(`The property '${name}' ${reason}. Received ${JSON.stringify(value)}`);
    Reflect.set(error, 'code', 'ERR_INVALID_ARG_VALUE');
    return error;
}

function validateString(name: string, value: unknown): void {
    if (value !== undefined && typeof value !== 'string') throw invalidArgType(name, 'string', value);
}

function validateOffset(name: string, value: unknown): void {
    if (value === undefined) return;
    if (typeof value !== 'number') throw invalidArgType(name, 'number', value);
    if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
}

function validateBoolean(name: string, value: unknown): void {
    if (value !== undefined && typeof value !== 'boolean') throw invalidArgType(name, 'boolean', value);
}

/**
 * Validate the vm.createContext() options bag. Measured against Node v24.18.0:
 * `name`/`origin` must be strings, `codeGeneration` must be a non-null object,
 * and its `strings`/`wasm` must be booleans. `undefined` is accepted for all.
 */
function validateCreateContextOptions(options: unknown): void {
    if (options === undefined) return;
    if (options === null || typeof options !== 'object') {
        const error = new TypeError(`The "options" argument must be of type object. Received ${typeName(options)}`);
        Reflect.set(error, 'code', 'ERR_INVALID_ARG_TYPE');
        throw error;
    }
    const opts = options as CreateContextOptions;
    validateString('options.name', opts.name);
    validateString('options.origin', opts.origin);
    if (opts.codeGeneration !== undefined) {
        if (opts.codeGeneration === null || typeof opts.codeGeneration !== 'object') {
            throw invalidArgType('options.codeGeneration', 'object', opts.codeGeneration);
        }
        validateBoolean('options.codeGeneration.strings', opts.codeGeneration.strings);
        validateBoolean('options.codeGeneration.wasm', opts.codeGeneration.wasm);
    }
}

function validateTimeout(value: unknown): void {
    if (value === undefined) return;
    if (typeof value !== 'number') throw invalidArgType('options.timeout', 'number', value);
    if (!Number.isInteger(value) || value < 1 || value > 4294967295) {
        throw outOfRange('options.timeout', '>= 1 && <= 4294967295', value);
    }
}

function isBufferSource(value: unknown): value is Buffer {
    return ArrayBuffer.isView(value);
}

function validateCachedData(value: unknown): void {
    if (value === undefined) return;
    if (!isBufferSource(value)) {
        const error = new TypeError('The "options.cachedData" property must be an instance of Buffer, TypedArray, or DataView. Received ' + typeName(value));
        Reflect.set(error, 'code', 'ERR_INVALID_ARG_TYPE');
        throw error;
    }
}

/** Node accepts a bare filename string wherever an options object is expected. */
function normalizeOptions<T extends RunningScriptOptions>(options?: T | string): T | undefined {
    if (typeof options === 'string') return { filename: options } as T;
    return options;
}

function validateCompileOptions(options?: RunningScriptOptions): void {
    if (!options) return;
    validateString('options.filename', options.filename);
    validateOffset('options.lineOffset', options.lineOffset);
    validateOffset('options.columnOffset', options.columnOffset);
    validateCachedData(options.cachedData);
}

function validateRunOptions(options?: RunningScriptOptions): void {
    validateCompileOptions(options);
    if (!options) return;
    validateTimeout(options.timeout);
}

/**
 * Shift reported positions by padding the source: QuickJS has no offset knob,
 * but leading newlines/spaces move line and column numbers the same way.
 */
function applyOffsets(code: string, lineOffset?: number, columnOffset?: number): string {
    const lines = lineOffset && lineOffset > 0 ? '\n'.repeat(lineOffset) : '';
    const columns = columnOffset && columnOffset > 0 && !code.startsWith('#!') ? ' '.repeat(columnOffset) : '';
    return lines + columns + code;
}

function compileOnly(code: string, filename: string): unknown {
    return engine.eval(code, filename, COMPILE_FLAGS);
}

function produceBytecode(code: string, filename: string): Buffer {
    return Buffer.from(engine.serialize(compileOnly(code, filename)));
}

interface ContextState {
    sandbox: InstanceType<typeof engine.Sandbox>;
    mirroredKeys: Set<string | symbol>;
    baselineKeys: Set<string | symbol>;
}

interface CompileContext {
    context: Context;
    refresh(): void;
    commit(): void;
}

const _contextMap = new WeakMap<Context, ContextState>();
const RESERVED_GLOBAL_KEYS = new Set<PropertyKey>([
    'global',
    'self',
    'window',
    "globalThis",

    "parseFloat",
    "parseInt",
    "isNaN",
    "isFinite",
    "decodeURI",
    "decodeURIComponent",
    "encodeURI",
    "encodeURIComponent",
    "escape",
    "unescape",

    "NaN",
    "Infinity",
    "undefined",

    "Object",
    "Function",
    "Array",
    "String",
    "Number",
    "Boolean",
    "Symbol",
    "Error",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
    "InternalError",
    "AggregateError",
    "SuppressedError",

    "Math",
    "Reflect",
    "Iterator",
    "GeneratorFunction",
    "DisposableStack",
    "Promise",
]);

/**
 * Intrinsics the Sandbox realm does NOT get from the C constructor, copied in
 * from the host. js_sandbox_ctor (circu.js/src/mod_engine.c:495-496) calls only
 * JS_AddIntrinsicBaseObjects + JS_AddIntrinsicEval, which is exactly why the
 * RESERVED_GLOBAL_KEYS set above is per-realm and everything below is NOT:
 * these bindings are the host's own objects, shared by identity (OBSERVED).
 *
 * Consequence, measured: a script inside the sandbox that assigns to
 * `Date.prototype.getFullYear` or `Map.prototype.get` changes those methods FOR
 * THE HOST. This is a real prototype-pollution channel out of the sandbox, and
 * it cannot be closed from TypeScript — you cannot mint a fresh native `Date`
 * constructor from JS, and dropping these keys would leave `Date` undefined,
 * which is worse. The fix belongs in the C constructor (add the remaining
 * intrinsics to app->ctx). `vm` here is NOT a security boundary; see the module
 * doc comment.
 */
const CONTEXT_GLOBAL_KEYS = [
    'Date',
    'RegExp',
    'JSON',
    'Proxy',
    'Intl',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'ArrayBuffer',
    'SharedArrayBuffer',
    'DataView',
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt',
    'BigInt64Array',
    'BigUint64Array',
    'Atomics',
    'WeakRef',
    'FinalizationRegistry',
    'WebAssembly',
    'Promise',
    'console',
] as const;

function installContextGlobals(scope: Context): void {
    for (const key of CONTEXT_GLOBAL_KEYS) {
        if (Reflect.has(scope, key) || !Reflect.has(globalThis, key)) continue;
        Reflect.set(scope, key, Reflect.get(globalThis, key));
    }
}

function getContextState(context: Context): ContextState {
    const state = _contextMap.get(context);
    if (!state) {
        const error = new TypeError('The "contextifiedObject" argument must be an vm.Context. Received an instance of Object');
        Reflect.set(error, 'code', 'ERR_INVALID_ARG_TYPE');
        throw error;
    }
    return state;
}

function validateContextObject(object: unknown): asserts object is Context {
    if (object === null || typeof object !== 'object') {
        const error = new TypeError('The "object" argument must be of type object. Received ' + typeName(object));
        Reflect.set(error, 'code', 'ERR_INVALID_ARG_TYPE');
        throw error;
    }
}

function copyIn(contextObject: Context, scope: Context, state: ContextState): void {
    const currentKeys = new Set(Reflect.ownKeys(contextObject));

    for (const key of Reflect.ownKeys(scope)) {
        if (!currentKeys.has(key) && !state.baselineKeys.has(key) && !RESERVED_GLOBAL_KEYS.has(key)) {
            Reflect.deleteProperty(scope, key);
        }
    }

    for (const key of Reflect.ownKeys(contextObject)) {
        if (RESERVED_GLOBAL_KEYS.has(key)) continue;
        const desc = Object.getOwnPropertyDescriptor(contextObject, key);
        if (!desc) continue;
        if ('value' in desc) {
            Reflect.set(scope, key, desc.value);
        } else if (typeof desc.get === 'function') {
            Reflect.set(scope, key, Reflect.get(contextObject, key));
        }
    }
}

function copyOut(contextObject: Context, state: ContextState): void {
    const scope = state.sandbox.global as Context;
    const currentKeys = new Set(Reflect.ownKeys(scope));

    for (const key of state.mirroredKeys) {
        if (!currentKeys.has(key) && !state.baselineKeys.has(key)) {
            Reflect.deleteProperty(contextObject, key);
        }
    }

    for (const key of currentKeys) {
        if (state.baselineKeys.has(key)) continue;
        const value = Reflect.get(scope, key);
        Reflect.set(contextObject, key, value);
    }

    state.mirroredKeys = new Set([...currentKeys].filter((key) => !state.baselineKeys.has(key)));
}

function buildFunctionExpression(code: string, params: string[]): string {
    const args = params.join(', ');
    // The body must start on line 1 so reported lines match Node, which subtracts
    // the wrapper offset inside V8. QuickJS has no such knob, so the header shares
    // line 1 with the body: every line number now agrees with Node, and only the
    // *column* of a line-1 frame is shifted by the header width. A leading newline
    // here would instead shift every reported line by +1.
    return `(function(${args}) {${code}\n})`;
}

/** Node reports the declared arity and an empty name on compiled functions. */
function declaredArity(params: string[]): number {
    let count = 0;
    for (const param of params) {
        if (param.includes('=') || param.trimStart().startsWith('...')) break;
        count++;
    }
    return count;
}

function attachCachedData<T extends VmCallable>(
    fn: T,
    params: string[],
    source: string,
    filename: string,
    options?: { produceCachedData?: boolean; cachedData?: Buffer },
): T {
    Object.defineProperty(fn, 'length', { value: declaredArity(params), configurable: true });
    Object.defineProperty(fn, 'name', { value: '', configurable: true });
    if (options?.cachedData !== undefined) {
        const current = produceBytecode(source, filename);
        Object.defineProperty(fn, 'cachedDataRejected', {
            value: !current.equals(Buffer.from(options.cachedData as unknown as Uint8Array)),
            configurable: true,
        });
    }
    if (options?.produceCachedData) {
        Object.defineProperty(fn, 'cachedData', { value: produceBytecode(source, filename), configurable: true });
        Object.defineProperty(fn, 'cachedDataProduced', { value: true, configurable: true });
    }
    return fn;
}

function isPromise(value: unknown): value is Promise<unknown> {
    return (typeof value === 'object' || typeof value === 'function')
        && value !== null
        && typeof Reflect.get(value, 'then') === 'function'
        && typeof Reflect.get(value, 'finally') === 'function';
}

function copySource(source: Context, target: Context): void {
    for (const key of Reflect.ownKeys(source)) {
        const desc = Object.getOwnPropertyDescriptor(source, key);
        if (!desc) continue;
        Reflect.set(target, key, 'value' in desc ? desc.value : Reflect.get(source, key));
    }
}

function resetContext(context: Context): void {
    for (const key of Reflect.ownKeys(context)) Reflect.deleteProperty(context, key);
}

function normalizeContextExtensions(extensions?: object[]): Context[] {
    if (!extensions || extensions.length === 0) return [];
    const out: Context[] = [];
    for (const extension of extensions) {
        validateContextObject(extension);
        out.push(extension);
    }
    return out;
}

function findExtensionOwner(extensions: Context[], key: PropertyKey): Context | undefined {
    for (let i = extensions.length - 1; i >= 0; i--) {
        const extension = extensions[i];
        if (extension && Object.prototype.hasOwnProperty.call(extension, key)) return extension;
    }
    return undefined;
}

function buildCompileContext(parsingContext?: Context, contextExtensions?: object[]): CompileContext | undefined {
    const extensions = normalizeContextExtensions(contextExtensions);
    if (extensions.length === 0) {
        if (!parsingContext) return undefined;
        getContextState(parsingContext);
        return { context: parsingContext, refresh() {}, commit() {} };
    }

    if (parsingContext) getContextState(parsingContext);
    const context: Context = {};
    const knownKeys = new Set<PropertyKey>();
    const refresh = () => {
        resetContext(context);
        if (parsingContext) copySource(parsingContext, context);
        for (const extension of extensions) copySource(extension, context);
        knownKeys.clear();
        for (const key of Reflect.ownKeys(context)) knownKeys.add(key);
    };
    const commit = () => {
        const keys = new Set([...knownKeys, ...Reflect.ownKeys(context)]);
        for (const key of keys) {
            const owner = findExtensionOwner(extensions, key);
            const target = owner ?? parsingContext;
            if (!target) continue;
            if (Object.prototype.hasOwnProperty.call(context, key)) {
                Reflect.set(target, key, Reflect.get(context, key));
            } else {
                Reflect.deleteProperty(target, key);
            }
        }
    };

    refresh();
    return { context: createContext(context), refresh, commit };
}

export class Script {
    private _code: string;
    private _filename: string;
    cachedData?: Buffer;
    cachedDataProduced?: boolean;
    cachedDataRejected?: boolean;

    constructor(code: string, options?: ScriptOptions | string) {
        const opts = normalizeOptions(options);
        validateCompileOptions(opts);
        this._code = applyOffsets(String(code), opts?.lineOffset, opts?.columnOffset);
        this._filename = opts?.filename ?? 'evalmachine.<anonymous>';

        // Node compiles eagerly, so a syntax error surfaces from the constructor.
        const bytecode = produceBytecode(this._code, this._filename);
        if (opts?.cachedData !== undefined) {
            this.cachedDataRejected = !bytecode.equals(Buffer.from(opts.cachedData as unknown as Uint8Array));
        }
        if (opts?.produceCachedData) {
            this.cachedData = bytecode;
            this.cachedDataProduced = true;
        }
    }

    runInThisContext(options?: RunningScriptOptions | string): unknown {
        const opts = normalizeOptions(options);
        validateRunOptions(opts);
        return runInThisContext(this._code, { ...opts, filename: opts?.filename ?? this._filename });
    }

    runInNewContext(contextObject?: Context, options?: RunningScriptOptions | string): unknown {
        const ctx = createContext(contextObject);
        return this.runInContext(ctx, options);
    }

    runInContext(context: Context, options?: RunningScriptOptions | string): unknown {
        const opts = normalizeOptions(options);
        validateRunOptions(opts);
        return runInContext(this._code, context, { ...opts, filename: opts?.filename ?? this._filename });
    }

    createCachedData(): Buffer {
        return produceBytecode(this._code, this._filename);
    }
}

export function createScript(code: string, options?: ScriptOptions | string): Script {
    return new Script(code, options);
}

/**
 * Enforce `createContext({ codeGeneration })`. Both flags were validated and
 * then ignored: with `{strings:false, wasm:false}` a context still evaluated
 * `eval('1+1')` to 2, `new Function('return 2')()` to 2, and compiled a
 * `WebAssembly.Module` (all OBSERVED). Node v24.18.0 on the same inputs throws
 * `EvalError: Code generation from strings disallowed for this context` and
 * `CompileError: WebAssembly.Module(): Wasm code generation disallowed by
 * embedder` (both OBSERVED).
 *
 * V8 enforces this inside the engine, so every alias of the capability dies at
 * once. QuickJS has no equivalent switch, so each reachable reference has to be
 * closed by hand:
 *   - `eval`: replacing the global binding blocks direct `eval(s)` AND indirect
 *     `(0,eval)(s)` — QuickJS resolves the binding at the call site (OBSERVED).
 *   - `Function`: the global binding alone is not enough, because
 *     `Function.prototype.constructor` is a second live reference to the same
 *     capability. Patching only that one still left `new Function('return 1')()`
 *     returning 1 (OBSERVED).
 *   - the generator and async function constructors, which have no global
 *     binding at all but are reachable as `(function*(){}).constructor`.
 * All of these are per-realm inside a Sandbox, so patching them cannot reach the
 * host. This is a capability fence only — it does not make the sandbox an
 * escape-proof boundary (see CONTEXT_GLOBAL_KEYS).
 */
const CODEGEN_MESSAGE = 'Code generation from strings disallowed for this context';
const WASM_MESSAGE = 'WebAssembly.Module(): Wasm code generation disallowed by embedder';

/** Throw the realm's own EvalError, so `instanceof EvalError` holds inside. */
function makeCodegenThrower(scope: Context): () => never {
    return function codegenBlocked(): never {
        const Ctor = Reflect.get(scope, 'EvalError');
        throw typeof Ctor === 'function'
            ? new (Ctor as new (message: string) => Error)(CODEGEN_MESSAGE)
            : new EvalError(CODEGEN_MESSAGE);
    };
}
/**
 * Every function constructor reachable inside the realm. `Function` has a global
 * binding; the generator and async variants do not, and are only reachable as
 * `(function*(){}).constructor`, so they are collected from samples minted inside
 * the realm itself.
 */
function realmFunctionCtors(sandbox: ContextState['sandbox'], scope: Context): Set<VmCallable> {
    const ctors = new Set<VmCallable>();
    const globalFn = Reflect.get(scope, 'Function');
    if (typeof globalFn === 'function') ctors.add(globalFn as VmCallable);
    let samples: unknown;
    try {
        samples = sandbox.call(
            '[function(){}, function*(){}, async function(){}, async function*(){}]',
            'node:vm/codegen',
        );
    } catch {
        samples = undefined;
    }
    if (Array.isArray(samples)) {
        for (const sample of samples) {
            if (typeof sample !== 'function') continue;
            const ctor = Reflect.get(sample as object, 'constructor');
            if (typeof ctor === 'function') ctors.add(ctor as VmCallable);
        }
    }
    return ctors;
}

function blockStringCodegen(sandbox: ContextState['sandbox'], scope: Context): void {
    const blocked = makeCodegenThrower(scope);
    try {
        Reflect.set(scope, 'eval', blocked);
    } catch { /* non-writable in this realm */ }

    for (const ctor of realmFunctionCtors(sandbox, scope)) {
        const guard = new Proxy(ctor, { apply: blocked, construct: blocked });
        // The global binding, when this ctor has one (Function does; the
        // generator/async ctors do not).
        if (Reflect.get(scope, ctor.name) === ctor) {
            try {
                Reflect.set(scope, ctor.name, guard);
            } catch { /* non-writable */ }
        }
        // The second live reference. Skipping this left `new Function(...)`
        // working through `(function(){}).constructor` (OBSERVED).
        const proto = Reflect.get(ctor, 'prototype');
        if (proto && (typeof proto === 'object' || typeof proto === 'function')) {
            try {
                Object.defineProperty(proto, 'constructor', {
                    value: guard, writable: true, enumerable: false, configurable: true,
                });
            } catch { /* frozen prototype */ }
        }
    }
}
function blockWasmCodegen(scope: Context): void {
    const wasm = Reflect.get(scope, 'WebAssembly');
    if (!wasm || typeof wasm !== 'object') return;
    const CompileError = Reflect.get(wasm as object, 'CompileError');
    const wasmError = (): Error =>
        typeof CompileError === 'function'
            ? new (CompileError as new (message: string) => Error)(WASM_MESSAGE)
            : new Error(WASM_MESSAGE);
    const raise = (): never => { throw wasmError(); };

    // The sandbox's `WebAssembly` IS the host's object (shared by identity), so
    // mutating it would disable wasm for the host too. Build a per-sandbox facade.
    const facade: Context = {};
    for (const key of Reflect.ownKeys(wasm as object)) {
        const value = Reflect.get(wasm as object, key);
        if (key === 'Module' || key === 'Instance') {
            Reflect.set(facade, key, new Proxy(value as object, { apply: raise, construct: raise }));
        } else if (
            key === 'compile' || key === 'instantiate'
            || key === 'compileStreaming' || key === 'instantiateStreaming'
        ) {
            // Node rejects rather than throwing synchronously on these.
            Reflect.set(facade, key, () => Promise.reject(wasmError()));
        } else {
            Reflect.set(facade, key, value);
        }
    }
    try {
        Reflect.set(scope, 'WebAssembly', facade);
    } catch { /* non-writable */ }
}

function applyCodeGeneration(
    sandbox: ContextState['sandbox'],
    scope: Context,
    codeGeneration?: { strings?: boolean; wasm?: boolean },
): void {
    if (!codeGeneration) return;
    if (codeGeneration.strings === false) blockStringCodegen(sandbox, scope);
    if (codeGeneration.wasm === false) blockWasmCodegen(scope);
}

export function createContext(contextObject?: Context | symbol, options?: CreateContextOptions): Context {
    validateCreateContextOptions(options);
    if (options?.microtaskMode !== undefined && options.microtaskMode !== 'afterEvaluate') {
        throw invalidArgValue('options.microtaskMode', options.microtaskMode, "must be one of: 'afterEvaluate', undefined");
    }
    // constants.DONT_CONTEXTIFY asks for a fresh global rather than a mirrored object.
    const target = contextObject === constants.DONT_CONTEXTIFY ? {} : contextObject;
    if (target !== undefined) validateContextObject(target);
    const context = (target ?? {}) as Context;
    const sandbox = new engine.Sandbox();
    const scope = sandbox.global as Context;
    Reflect.set(scope, 'global', scope);
    Reflect.set(scope, 'self', scope);
    Reflect.set(scope, 'window', scope);
    installContextGlobals(scope);
    installSandboxErrorStacks(scope);
    applyCodeGeneration(sandbox, scope, options?.codeGeneration);
    const state: ContextState = {
        sandbox,
        mirroredKeys: new Set(Reflect.ownKeys(context)),
        baselineKeys: new Set(Reflect.ownKeys(scope)),
    };
    copyIn(context, scope, state);
    _contextMap.set(context, state);
    return context;
}

export function isContext(object: Context): boolean {
    validateContextObject(object);
    return _contextMap.has(object);
}

export function runInThisContext(code: string, options?: RunningScriptOptions | string): unknown {
    const opts = normalizeOptions(options);
    validateRunOptions(opts);
    const source = applyOffsets(code, opts?.lineOffset, opts?.columnOffset);
    // engine.eval(EVAL_GLOBAL) matches (0,eval) but honours the filename in stacks.
    return engine.eval(source, opts?.filename ?? 'evalmachine.<anonymous>', engine.EVAL_GLOBAL);
}

export function runInNewContext(code: string, contextObject?: Context, options?: RunningScriptOptions | string): unknown {
    const ctx = createContext(contextObject);
    return runInContext(code, ctx, options);
}

/**
 * Sandbox realms get their own native error constructors (they are in
 * RESERVED_GLOBAL_KEYS), so an error born inside one never passes through the
 * host's `Error` proxy in `webapi/basic.ts` and never gets a `stack` header —
 * QuickJS's own `stack` is frames-only. Real Node's stack for a cross-realm
 * error DOES carry the `Error: message` header (measured on v24.18.0), and
 * `util.inspect` renders it, so `console.log` of a cross-realm error printed
 * `[    at <eval> …]` instead of `Error: cross realm`.
 *
 * Mirrors the host's approach rather than inventing a second one: wrap the
 * realm's error constructors so each instance gets a lazy `stack` accessor that
 * synthesizes `name: message` above the captured frames on read. Lazy matters —
 * a setter lets a user-assigned stack win, which is what Node does (measured:
 * `q.stack = '    at custom (z.js:1:1)'` survives verbatim and headerless).
 *
 * `instanceof Error` stays false across the realm boundary because the proxy
 * keeps the sandbox constructor as its target and does not touch prototypes;
 * that divergence from the host realm is correct, Node behaves the same way.
 *
 * Not attempted: Node also prefixes an `evalmachine.<anonymous>:1\n<source>\n^`
 * source-excerpt preamble on vm errors. That is separate from the header.
 */
const SANDBOX_ERROR_CTORS = [
    'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
    'TypeError', 'URIError', 'InternalError', 'AggregateError', 'SuppressedError',
] as const;

function installLazySandboxErrorStack(error: unknown): unknown {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return error;
    let frames: unknown;
    try {
        frames = (error as { stack?: unknown }).stack;
    } catch {
        return error; // hostile getter
    }
    // Leave non-string stacks alone (prepareStackTrace CallSite arrays).
    if (typeof frames !== 'string') return error;
    // Drop the frames our own Proxy traps add. Without this the user sees
    // `at construct (native)` / `at construct (node:vm/mod:…)` above their real
    // frame — the host's Error proxy strips the same pair in webapi/basic.ts.
    const captured = frames
        .split('\n')
        .filter((line) => {
            const frame = line.trimStart();
            return frame !== 'at construct (native)'
                && frame !== 'at apply (native)'
                && !frame.startsWith('at construct (node:vm/mod')
                && !frame.startsWith('at apply (node:vm/mod');
        })
        .join('\n')
        .replace(/\n$/, '');

    let customStack: unknown;
    let hasCustomStack = false;
    try {
        Object.defineProperty(error, 'stack', {
            configurable: true,
            enumerable: false,
            get() {
                if (hasCustomStack) return customStack;
                const self = this as { name?: unknown; message?: unknown };
                const name = self?.name === undefined ? 'Error' : String(self.name);
                const message = self?.message === undefined ? '' : String(self.message);
                const header = message === '' ? name : (name === '' ? message : `${name}: ${message}`);
                return captured ? `${header}\n${captured}` : header;
            },
            set(value) {
                customStack = value;
                hasCustomStack = true;
            },
        });
    } catch { /* frozen error: leave as-is */ }
    return error;
}

function installSandboxErrorStacks(scope: Context): void {
    for (const name of SANDBOX_ERROR_CTORS) {
        const ctor = Reflect.get(scope, name);
        if (typeof ctor !== 'function') continue;
        const proxy = new Proxy(ctor, {
            apply(target, thisArg, args) {
                return installLazySandboxErrorStack(Reflect.apply(target, thisArg, args));
            },
            construct(target, args, newTarget) {
                // newTarget is forwarded so subclasses keep their own prototype.
                return installLazySandboxErrorStack(Reflect.construct(target, args, newTarget)) as object;
            },
        });
        try {
            Reflect.set(scope, name, proxy);
        } catch { /* non-writable in this realm: skip */ }
    }
}

export function runInContext(code: string, context: Context, options?: RunningScriptOptions | string): unknown {
    const opts = normalizeOptions(options);
    validateRunOptions(opts);
    const state = getContextState(context);
    const scope = state.sandbox.global as Context;
    copyIn(context, scope, state);
    const source = applyOffsets(code, opts?.lineOffset, opts?.columnOffset);
    const filename = opts?.filename ?? 'evalmachine.<anonymous>';
    let result: unknown;
    try {
        result = state.sandbox.call(source, filename);
    } catch (error) {
        // Node mirrors writes back even when the script throws (measured: a
        // script that sets a global then throws still leaves it on the context
        // object), so copyOut must not be skipped on the error path.
        copyOut(context, state);
        throw error;
    }
    if (isPromise(result)) {
        return result.then(
            (value) => { copyOut(context, state); return value; },
            (error) => { copyOut(context, state); throw error; },
        );
    }
    copyOut(context, state);
    return result;
}

interface CompileFunctionOptions {
    filename?: string;
    lineOffset?: number;
    columnOffset?: number;
    cachedData?: Buffer;
    produceCachedData?: boolean;
    parsingContext?: Context;
    contextExtensions?: object[];
}

export function compileFunction(code: string, params?: string[], options?: CompileFunctionOptions): VmCallable {
    if (params !== undefined && !Array.isArray(params)) {
        const error = new TypeError('The "params" argument must be an instance of Array. Received ' + typeName(params));
        Reflect.set(error, 'code', 'ERR_INVALID_ARG_TYPE');
        throw error;
    }
    validateCompileOptions(options);
    if (options?.parsingContext !== undefined) validateContextObject(options.parsingContext);
    const names = params ?? [];
    const filename = options?.filename ?? 'evalmachine.<anonymous>';
    const body = applyOffsets(code, options?.lineOffset, options?.columnOffset);
    const compileContext = buildCompileContext(options?.parsingContext, options?.contextExtensions);
    const source = buildFunctionExpression(body, names);
    if (!compileContext) {
        const plain = engine.eval(source, filename, engine.EVAL_GLOBAL) as VmCallable;
        return attachCachedData(plain, names, source, filename, options);
    }

    const state = getContextState(compileContext.context);
    const fn = state.sandbox.call(source, filename);
    if (typeof fn !== 'function') {
        throw new TypeError('Failed to compile function');
    }
    return attachCachedData(function (this: unknown, ...args: unknown[]) {
        compileContext.refresh();
        const context = compileContext.context;
        const scope = state.sandbox.global as Context;
        copyIn(context, scope, state);
        const result = Reflect.apply(fn as (...innerArgs: unknown[]) => unknown, this, args);
        if (isPromise(result)) {
            return result.finally(() => {
                copyOut(context, state);
                compileContext.commit();
            });
        }
        copyOut(context, state);
        compileContext.commit();
        return result;
    }, names, source, filename, options);
}

interface MemoryMeasurement {
    total: { jsMemoryEstimate: number; jsMemoryAllocated: number };
    native: { jsMemoryEstimate: number; jsMemoryAllocated: number };
    external: number;
}

export function measureMemory(options?: { mode?: 'summary' | 'detailed'; execution?: 'default' | 'eager'; context?: Context }): Promise<MemoryMeasurement> {
    if (options?.mode !== undefined && options.mode !== 'summary' && options.mode !== 'detailed') {
        throw invalidArgValue('options.mode', options.mode, "must be one of: 'summary', 'detailed'");
    }
    if (options?.execution !== undefined && options.execution !== 'default' && options.execution !== 'eager') {
        throw invalidArgValue('options.execution', options.execution, "must be one of: 'default', 'eager'");
    }
    return Promise.resolve({
        total: { jsMemoryEstimate: 0, jsMemoryAllocated: 0 },
        native: { jsMemoryEstimate: 0, jsMemoryAllocated: 0 },
        external: 0,
    });
}
