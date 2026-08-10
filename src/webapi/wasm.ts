/**
 * WebAssembly JavaScript API Polyfill for txiki.js
 *
 * Bridges the low-level WAMR C backend (CModuleWASM) to the standard
 * WebAssembly global, implementing the WebAssembly JS API specification.
 *
 * The WAMR API requires explicit import resolution before building instances,
 * unlike the standard API which accepts an importObject at instantiation.
 * This polyfill handles the conversion automatically.
 *
 * @see {@link https://webassembly.github.io/spec/js-api/}
 */

const wasmModule = import.meta.use('wasm');
if (!wasmModule) throw new Error('WASM support is not available in this build');
const wasm = wasmModule;
const engine = import.meta.use('engine');

type BufferSource = ArrayBuffer | ArrayBufferView;
type WasmImportObject = Record<string, Record<string, unknown>>;
type WasmFunctionExport = (...args: CModuleWASM.WasmFunctionArgument[]) => CModuleWASM.WasmFunctionResult;
type WasmExportValue = WasmFunctionExport | Memory | Table | Global;
type WasmExports = Record<string, WasmExportValue>;
type WebAssemblyFacade = {
    Module: typeof Module;
    Instance: typeof Instance;
    Memory: typeof Memory;
    Table: typeof Table;
    Global: typeof Global;
    CompileError: typeof CompileError;
    LinkError: typeof LinkError;
    RuntimeError: typeof RuntimeError;
    readonly [Symbol.toStringTag]: string;
    validate(bufferSource: BufferSource): boolean;
    compile(bufferSource: BufferSource): Promise<Module>;
    instantiate(source: BufferSource | Module, importObject?: WasmImportObject): Promise<Instance | { module: Module; instance: Instance }>;
    compileStreaming(source: Response | Promise<Response>): Promise<Module>;
    instantiateStreaming(source: Response | Promise<Response>, importObject?: WasmImportObject): Promise<{ module: Module; instance: Instance }>;
};
type WasmErrorLike = {
    message?: unknown;
    name?: unknown;
    code?: unknown;
    /*
     * The C layer tags every wasm error with the JS class it should surface as:
     * tjs_throw_wasm_error() (circu.js/src/mod_wasm.c) throws a plain Error
     * carrying `wasmError: "RuntimeError" | "CompileError" | "LinkError" |
     * "RangeError" | "TypeError"`. It cannot set `name`, because the thrown
     * object is a bare JS_NewError, so this marker is the only channel.
     */
    wasmError?: unknown;
};

function toArrayBuffer(source: BufferSource): ArrayBuffer {
    if (source instanceof ArrayBuffer) return source;
    const ret = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    if (ret instanceof SharedArrayBuffer)
        throw new TypeError('SharedArrayBuffer is not supported');
    return ret;
}

function toUint8Array(source: BufferSource): Uint8Array {
    if (source instanceof Uint8Array) return source;
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    /*
     * A non-BufferSource must raise a TypeError, not be reported as an invalid
     * module. WebAssembly.validate('x') returning false claimed the argument was
     * a well-formed-but-invalid module, hiding the caller's type error.
     */
    if (typeof source !== 'object' || source === null || !('buffer' in source)) {
        throw new TypeError('first argument must be an ArrayBuffer or a typed array object');
    }
    if (source.buffer instanceof SharedArrayBuffer)
        throw new TypeError('SharedArrayBuffer is not supported');
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

/*
 * Re-throw a native wasm failure as the class the WebAssembly JS API specifies.
 *
 * The classification MUST come from the `wasmError` marker the C layer sets:
 * tjs_throw_wasm_error() builds a bare Error, so `name` is always "Error" and
 * `code` is absent. Reading only those left every trap surfacing as a plain
 * Error, so `catch (e) { e instanceof WebAssembly.RuntimeError }` never matched
 * and a trap was indistinguishable from an ordinary JS bug.
 */
function wrapWasmError<T>(fn: () => T): T {
    try {
        return fn();
    } catch (e: unknown) {
        const record = typeof e === 'object' && e !== null ? e as WasmErrorLike : undefined;
        const msg = typeof record?.message === 'string' ? record.message : String(e);
        const tag = String(record?.wasmError || record?.name || record?.code || '');
        if (tag.includes('Compile')) throw new CompileError(msg);
        if (tag.includes('Link')) throw new LinkError(msg);
        if (tag.includes('Runtime')) throw new RuntimeError(msg);
        /* RangeError/TypeError are real JS classes; only re-wrap when the native
         * side asked for them but could not construct them itself. */
        if (tag === 'RangeError' && !(e instanceof RangeError)) throw new RangeError(msg);
        if (tag === 'TypeError' && !(e instanceof TypeError)) throw new TypeError(msg);
        throw e;
    }
}

/*
 * All custom sections with the given name, in module order.
 *
 * A name that is not present must yield an EMPTY array. Returning a
 * zero-length ArrayBuffer instead made `customSections(m, 'nope').length` equal
 * 1, so every presence test succeeded for every name.
 */
function customSectionsByName(module: CModuleWASM.Module, sectionName: string): ArrayBuffer[] {
    const section = wasm.moduleCustomSections(module, sectionName);
    return Array.isArray(section) ? section : section ? [section] : [];
}

/*
 * funcref bridging for Tables.
 *
 * The C layer represents a funcref table slot as a raw function index and
 * documents "JS side wraps it" (mod_wasm.c tjs_wasm_tableget), but nothing did,
 * so Table.get() returned a Number where the spec requires a callable. Worse,
 * tjs_wasm_tableset coerces with JS_ToUint32, so a plain JS function became
 * NaN -> 0 and silently aliased table slot 0 to function index 0 instead of
 * being rejected.
 *
 * A wrapper carries its index under this symbol so set() can recover it.
 */
const FUNCREF_INDEX = Symbol('wasmFuncrefIndex');
const FUNCREF_INSTANCE = Symbol('wasmFuncrefInstance');
const funcrefCache = new WeakMap<CModuleWASM.Instance, Map<number, FuncrefWrapper>>();
type FuncrefWrapper = WasmFunctionExport & {
    [FUNCREF_INDEX]: number;
    [FUNCREF_INSTANCE]: CModuleWASM.Instance;
};

/* The element type reaches this layer from two sources with different spellings:
 * a JS-constructed Table uses the descriptor's "anyfunc" (the WebAssembly JS API
 * name), while an imported/exported one is described by wasm.getTableInfo(),
 * which reports WAMR's "funcref". Both denote a function table. */
function isFuncrefElement(element: string): boolean {
    return element === 'anyfunc' || element === 'funcref';
}

function wrapFuncref(instance: CModuleWASM.Instance, funcIndex: number): FuncrefWrapper {
    let cache = funcrefCache.get(instance);
    if (!cache) {
        cache = new Map();
        funcrefCache.set(instance, cache);
    }
    const cached = cache.get(funcIndex);
    if (cached) return cached;
    const fn = ((...args: CModuleWASM.WasmFunctionArgument[]) =>
        wrapWasmError(() => wasm.callFuncByIndex(instance, funcIndex, ...args))) as FuncrefWrapper;
    Object.defineProperty(fn, FUNCREF_INDEX, { value: funcIndex, enumerable: false });
    Object.defineProperty(fn, FUNCREF_INSTANCE, { value: instance, enumerable: false });
    cache.set(funcIndex, fn);
    return fn;
}

function isFuncrefWrapper(v: unknown): v is FuncrefWrapper {
    return typeof v === 'function' && typeof (v as FuncrefWrapper)[FUNCREF_INDEX] === 'number';
}

// Error Classes

class CompileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CompileError';
    }
    
    get [Symbol.toStringTag]() {
        return 'CompileError';
    }
}

class LinkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LinkError';
    }
    
    get [Symbol.toStringTag]() {
        return 'LinkError';
    }
}

class RuntimeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RuntimeError';
    }
    
    get [Symbol.toStringTag]() {
        return 'RuntimeError';
    }
}

// Module

class Module {
    _native: CModuleWASM.Module;

    constructor(bufferSource: BufferSource) {
        this._native = wrapWasmError(() => wasm.parseModule(toArrayBuffer(bufferSource)));
    }

    static exports(module: Module): WebAssembly.ModuleExportDescriptor[] {
        return wasm.moduleExports(module._native);
    }

    static imports(module: Module): WebAssembly.ModuleImportDescriptor[] {
        return wasm.moduleImports(module._native);
    }

    static customSections(module: Module, sectionName: string): ArrayBuffer[] {
        return customSectionsByName(module._native, sectionName);
    }
    
    get [Symbol.toStringTag]() {
        return 'WebAssembly.Module';
    }
}

// Memory

class Memory {
    _instance: CModuleWASM.Instance | null;
    _buffer: ArrayBuffer | null;
    _cachedBuffer: ArrayBuffer | null;
    _maxPages: number | undefined;

    constructor(descriptor: { initial: number; maximum?: number; shared?: boolean }) {
        /* `initial` is required by the JS API. Without this check `new
         * Memory({})` produced a 0-page memory whose NaN-sized buffer surfaced
         * much later as an unrelated failure. */
        const rawInitial = descriptor !== null && typeof descriptor === 'object'
            ? descriptor.initial
            : undefined;
        const initial = toWasmPageCount(rawInitial, 'initial');
        const maximum = descriptor !== null && typeof descriptor === 'object'
            ? toOptionalWasmPageCount(descriptor.maximum, 'maximum')
            : undefined;
        if (maximum !== undefined && maximum < initial) {
            throw new RangeError('WebAssembly.Memory(): Property "maximum" is below the initial size');
        }
        if (descriptor?.shared === true) {
            /* The native bridge currently exposes ArrayBuffer-backed memories
             * only. Silently accepting shared:true would violate the API's
             * SharedArrayBuffer/atomic semantics, so fail at construction. */
            throw new TypeError('WebAssembly.Memory shared memories are not supported');
        }
        this._instance = null;
        this._buffer = new ArrayBuffer(initial * 65536);
        this._cachedBuffer = this._buffer;
        this._maxPages = maximum;
    }

    private localBuffer(): ArrayBuffer {
        if (!this._buffer) throw new RuntimeError('WebAssembly.Memory buffer has been detached');
        return this._buffer;
    }

    get buffer(): ArrayBuffer {
        const instance = this._instance;
        if (instance) {
            this._cachedBuffer = wasm.getMemoryBuffer(instance);
            return this._cachedBuffer;
        }
        return this.localBuffer();
    }

    grow(delta: number): number {
        const pages = toWasmPageCount(delta, 'delta');
        const instance = this._instance;
        if (instance) {
            const result = wrapWasmError(() => wasm.growMemory(instance, pages));
            this._cachedBuffer = wasm.getMemoryBuffer(instance);
            return result;
        }
        const oldBuffer = this.localBuffer();
        const oldPages = oldBuffer.byteLength / 65536;
        const newPages = oldPages + pages;
        /* The JS API specifies a RangeError when the grow cannot be satisfied;
         * returning -1 is the wasm `memory.grow` instruction's convention, not
         * this method's, and made an over-max grow look like success to any
         * caller that did not compare against -1. */
        if (this._maxPages !== undefined && newPages > this._maxPages) {
            throw new RangeError('failed to grow memory');
        }
        if (newPages > 65536) throw new RangeError('failed to grow memory');
        const newBuffer = new ArrayBuffer(newPages * 65536);
        new Uint8Array(newBuffer).set(new Uint8Array(oldBuffer));
        engine.detachArrayBuffer(oldBuffer);
        this._buffer = newBuffer;
        this._cachedBuffer = newBuffer;
        return oldPages;
    }
    
    get [Symbol.toStringTag]() {
        return 'WebAssembly.Memory';
    }
}

function toWasmPageCount(value: unknown, name: string): number {
    if (typeof value === 'bigint') {
        throw new TypeError(`WebAssembly.Memory(): Property '${name}' must be convertible to a valid number`);
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new TypeError(`WebAssembly.Memory(): Property '${name}' must be non-negative and finite`);
    }
    const pages = Math.trunc(number);
    if (pages > 65536) throw new RangeError(`WebAssembly.Memory(): Property '${name}' is too large`);
    return pages;
}

function toOptionalWasmPageCount(value: unknown, name: string): number | undefined {
    return value === undefined ? undefined : toWasmPageCount(value, name);
}

// Table

const VALID_GLOBAL_TYPES = new Set(['i32', 'i64', 'f32', 'f64']);
const VALID_ELEMENT_TYPES = new Set(['anyfunc', 'funcref', 'externref']);
const MAX_TABLE_ELEMENTS = 10_000_000;

class Table {
    _instance: CModuleWASM.Instance | null;
    _name: string | null;
    _element: string;
    _array: CModuleWASM.WasmTableValue[];
    _maxSize: number | undefined;

    constructor(descriptor: { element: string; initial: number; maximum?: number }) {
        const element = descriptor !== null && typeof descriptor === 'object'
            ? String(descriptor.element)
            : '';
        if (!VALID_ELEMENT_TYPES.has(element)) {
            throw new TypeError(`Invalid table element type: '${element}'`);
        }
        const initial = toTableSize(descriptor.initial, 'initial');
        const maximum = descriptor.maximum === undefined
            ? undefined
            : toTableSize(descriptor.maximum, 'maximum');
        if (maximum !== undefined && maximum < initial) {
            throw new RangeError('WebAssembly.Table(): Property "maximum" is below the initial size');
        }
        this._instance = null;
        this._name = null;
        this._element = element;
        this._maxSize = maximum;
        this._array = new Array(initial).fill(null);
    }

    private nativeBinding(): { instance: CModuleWASM.Instance; name: string } | null {
        if (!this._instance) return null;
        if (!this._name) throw new RuntimeError('WebAssembly.Table native binding is missing its export name');
        return { instance: this._instance, name: this._name };
    }

    get length(): number {
        const native = this.nativeBinding();
        if (native) return wasm.tableSize(native.instance, native.name);
        return this._array.length;
    }

    get(index: number): CModuleWASM.WasmTableValue {
        const tableIndex = toTableIndex(index);
        const native = this.nativeBinding();
        if (native) {
            if (tableIndex >= wasm.tableSize(native.instance, native.name)) {
                throw new RangeError('index out of bounds');
            }
            const raw = wasm.tableGet(native.instance, native.name, tableIndex);
            /* A funcref slot arrives as a raw function index; the spec requires a
             * callable. externref slots and null pass through unchanged. */
            if (isFuncrefElement(this._element) && typeof raw === 'number') {
                return wrapFuncref(native.instance, raw) as unknown as CModuleWASM.WasmTableValue;
            }
            return raw;
        }
        if (tableIndex >= this._array.length) {
            throw new RangeError('index out of bounds');
        }
        return this._array[tableIndex];
    }

    set(index: number, value: CModuleWASM.WasmTableValue): void {
        const tableIndex = toTableIndex(index);
        const native = this.nativeBinding();
        if (native) {
            if (tableIndex >= wasm.tableSize(native.instance, native.name)) {
                throw new RangeError('index out of bounds');
            }
            let toStore = value;
            if (isFuncrefElement(this._element) && value !== null) {
                /* Only a wasm funcref may be stored. Without this check the C
                 * layer's JS_ToUint32 turns any other value into 0 and silently
                 * aliases the slot to function index 0. */
                if (!isFuncrefWrapper(value)
                    || value[FUNCREF_INSTANCE] !== native.instance) {
                    throw new TypeError('Argument 1 must be null or a WebAssembly function');
                }
                toStore = (value as FuncrefWrapper)[FUNCREF_INDEX] as unknown as CModuleWASM.WasmTableValue;
            }
            wasm.tableSet(native.instance, native.name, tableIndex, toStore);
            return;
        }
        if (tableIndex >= this._array.length) {
            throw new RangeError('index out of bounds');
        }
        if (isFuncrefElement(this._element) && value !== null && !isFuncrefWrapper(value)) {
            throw new TypeError('Argument 1 must be null or a WebAssembly function');
        }
        this._array[tableIndex] = value;
    }

    grow(delta: number, init?: CModuleWASM.WasmTableValue): number {
        const count = toTableSize(delta, 'delta');
        const initialValue = arguments.length < 2 ? null : init;
        const native = this.nativeBinding();
        if (native) {
            if (isFuncrefElement(this._element) && initialValue !== null
                && (!isFuncrefWrapper(initialValue) || initialValue[FUNCREF_INSTANCE] !== native.instance)) {
                throw new TypeError('Argument 1 must be null or a WebAssembly function');
            }
            const grown = wasm.tableGrow(native.instance, native.name, count);
            /* WAMR reports refusal as -1; the JS API specifies a RangeError. */
            if (grown < 0) throw new RangeError('failed to grow table');
            for (let i = 0; i < count; i++) this.set(grown + i, initialValue);
            return grown;
        }
        const oldLength = this._array.length;
        const newLength = oldLength + count;
        if (this._maxSize !== undefined && newLength > this._maxSize) {
            throw new RangeError('failed to grow table');
        }
        if (newLength > MAX_TABLE_ELEMENTS) throw new RangeError('failed to grow table');
        if (isFuncrefElement(this._element) && initialValue !== null && !isFuncrefWrapper(initialValue)) {
            throw new TypeError('Argument 1 must be null or a WebAssembly function');
        }
        for (let i = 0; i < count; i++) {
            this._array.push(initialValue);
        }
        return oldLength;
    }
    
    get [Symbol.toStringTag]() {
        return 'WebAssembly.Table';
    }
}

function toTableSize(value: unknown, name: string): number {
    if (typeof value === 'bigint') throw new TypeError('Cannot convert a BigInt value to a number');
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw new TypeError(`WebAssembly.Table(): Property '${name}' must be non-negative and finite`);
    }
    const size = Math.trunc(number);
    if (size > MAX_TABLE_ELEMENTS) throw new RangeError(`WebAssembly.Table(): Property '${name}' is too large`);
    return size;
}

function toTableIndex(value: unknown): number {
    if (typeof value === 'bigint') throw new TypeError('Cannot convert a BigInt value to a number');
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new TypeError('table index must be non-negative and finite');
    const index = Math.trunc(number);
    if (index > 0xffffffff) throw new RangeError('index out of bounds');
    return index;
}

// Global

class Global {
    _instance: CModuleWASM.Instance | null;
    _name: string | null;
    _value: CModuleWASM.WasmGlobalValue;
    _mutable: boolean;
    _type: string;

    constructor(descriptor: { value: string; mutable: boolean }, initialValue: CModuleWASM.WasmGlobalValue) {
        if (!VALID_GLOBAL_TYPES.has(descriptor.value)) {
            throw new TypeError(`Invalid global type: '${descriptor.value}'`);
        }
        validateGlobalValue(descriptor.value, initialValue);
        this._instance = null;
        this._name = null;
        this._type = descriptor.value;
        this._mutable = descriptor.mutable;
        this._value = coerceGlobalValue(descriptor.value, initialValue);
    }

    private nativeBinding(): { instance: CModuleWASM.Instance; name: string } | null {
        if (!this._instance) return null;
        if (!this._name) throw new RuntimeError('WebAssembly.Global native binding is missing its export name');
        return { instance: this._instance, name: this._name };
    }

    get value(): CModuleWASM.WasmGlobalValue {
        const native = this.nativeBinding();
        if (native) return wasm.getGlobal(native.instance, native.name);
        return this._value;
    }

    set value(newValue: CModuleWASM.WasmGlobalValue) {
        if (!this._mutable) throw new TypeError('Global is immutable');
        validateGlobalValue(this._type, newValue);
        const coerced = coerceGlobalValue(this._type, newValue);
        const native = this.nativeBinding();
        if (native) {
            wasm.setGlobal(native.instance, native.name, coerced);
            return;
        }
        this._value = coerced;
    }

    valueOf(): CModuleWASM.WasmGlobalValue {
        return this.value;
    }
    
    get [Symbol.toStringTag]() {
        return 'WebAssembly.Global';
    }
}

function validateGlobalValue(type: string, value: CModuleWASM.WasmGlobalValue): void {
    switch (type) {
        case 'i32':
            toWasmNumber(value);
            break;
        case 'i64':
            if (typeof value !== 'bigint') {
                throw new TypeError('Global value must be a BigInt for i64 type');
            }
            break;
        case 'f32':
        case 'f64':
            toWasmNumber(value);
            break;
    }
}

/*
 * Round an f32 global's value to f32 precision.
 *
 * A JS number is f64. Storing 0.1 in an f32 global and reading it back must
 * yield 0.10000000149011612, the nearest f32; returning 0.1 unchanged reports a
 * value the global cannot actually hold, and the discrepancy only surfaces once
 * wasm reads the same global and disagrees with JS.
 */
function coerceGlobalValue(type: string, value: CModuleWASM.WasmGlobalValue): CModuleWASM.WasmGlobalValue {
    if (type === 'i32') {
        return toWasmNumber(value) | 0;
    }
    if (type === 'f32') return Math.fround(toWasmNumber(value));
    if (type === 'f32' || type === 'f64') return toWasmNumber(value);
    return value;
}

function toWasmNumber(value: unknown): number {
    /* ToNumber, unlike Number(), rejects BigInt values for WebAssembly's
     * numeric conversion. */
    if (typeof value === 'bigint') throw new TypeError('Cannot convert a BigInt value to a number');
    return Number(value);
}

// Instance

class Instance {
    _instance: CModuleWASM.Instance;
    _exports: WasmExports;

    constructor(module: Module, importObject?: WasmImportObject) {
        const nativeModule = module._native;
        if (importObject !== undefined && (typeof importObject !== 'object' || importObject === null)) {
            throw new TypeError('WebAssembly.Instance(): Argument 1 must be an object');
        }
        if (importObject) {
            resolveImportObject(nativeModule, importObject);
        } else if (requiresImportObject(nativeModule)) {
            /* A module declaring non-WASI imports cannot be instantiated with no
             * import object. Skipping resolution entirely linked it against
             * nothing and produced a live Instance whose imported calls were
             * unbound. */
            throw new TypeError('WebAssembly.Instance(): Argument 1 must be an object');
        }
        this._instance = wrapWasmError(() => wasm.buildInstance(nativeModule));
        this._exports = createExports(this._instance, nativeModule);
        Object.freeze(this._exports);
    }

    get exports(): WasmExports {
        return this._exports;
    }
    
    get [Symbol.toStringTag]() {
        return 'WebAssembly.Instance';
    }
}

// Import Resolution

/*
 * True when the module declares an import that an omitted import object cannot
 * satisfy. WASI modules are exempt: the runtime supplies wasi_snapshot_preview1
 * itself (see resolveImportObject), so they legitimately instantiate with none.
 */
function requiresImportObject(nativeModule: CModuleWASM.Module): boolean {
    for (const imp of wasm.moduleImports(nativeModule)) {
        if (imp.module !== 'wasi_snapshot_preview1' && imp.module !== 'wasi_unstable') {
            return true;
        }
    }
    return false;
}

function resolveImportObject(
    nativeModule: CModuleWASM.Module,
    importObject: WasmImportObject
): void {
    const imports = wasm.moduleImports(nativeModule);
    const functionDescs: CModuleWASM.ImportFunctionDescriptor[] = [];
    const globalDescs: CModuleWASM.GlobalImportDescriptor[] = [];
    const memoryDescs: { module: string; name: string; memory: Memory }[] = [];
    const tableDescs: { module: string; name: string; table: Table }[] = [];
    let wasiSet = false;

    for (const imp of imports) {
        const isWasi = imp.module === 'wasi_snapshot_preview1' || imp.module === 'wasi_unstable';
        const moduleObj = importObject[imp.module];
        const value = moduleObj ? moduleObj[imp.name] : undefined;

        if (value === undefined) {
            if (isWasi) {
                if (!wasiSet) {
                    wasm.setWasiOptions(nativeModule, [], null, null);
                    wasiSet = true;
                }
                continue;
            }
            throw new LinkError(
                `import object field '${imp.module}.${imp.name}' is not provided`
            );
        }

        switch (imp.kind) {
            case 'function':
                if (typeof value !== 'function') {
                    throw new LinkError(
                        `import object field '${imp.module}.${imp.name}' is not a Function`
                    );
                }
                functionDescs.push({ module: imp.module, name: imp.name, func: value as CModuleWASM.ImportFunctionDescriptor['func'] });
                break;
            case 'global':
                if (value instanceof Global) {
                    globalDescs.push({
                        module: imp.module,
                        name: imp.name,
                        value: toGlobalImportValue(value._value),
                        type: value._type as CModuleWASM.GlobalImportDescriptor['type'],
                        mutable: value._mutable,
                    });
                } else {
                    globalDescs.push({
                        module: imp.module,
                        name: imp.name,
                        value: typeof value === 'bigint' ? value : Number(value),
                        type: inferGlobalType(value),
                        mutable: false,
                    });
                }
                break;
            case 'memory':
                if (!(value instanceof Memory)) {
                    throw new LinkError(
                        `import object field '${imp.module}.${imp.name}' is not a WebAssembly.Memory`
                    );
                }
                memoryDescs.push({ module: imp.module, name: imp.name, memory: value });
                break;
            case 'table':
                if (!(value instanceof Table)) {
                    throw new LinkError(
                        `import object field '${imp.module}.${imp.name}' is not a WebAssembly.Table`
                    );
                }
                tableDescs.push({ module: imp.module, name: imp.name, table: value });
                break;
        }
    }

    if (functionDescs.length > 0) {
        wrapWasmError(() => wasm.resolveImports(nativeModule, functionDescs));
    }
    if (globalDescs.length > 0) {
        wrapWasmError(() => wasm.resolveGlobalImports(nativeModule, globalDescs));
    }
    wrapWasmError(() => wasm.resolveMemoryImports(nativeModule, memoryDescs.map(e => ({
        ...e, initial: 1
    }))));
    wrapWasmError(() => wasm.resolveTableImports(nativeModule, tableDescs.map(e => ({
        module: e.module,
        name: e.name,
        element: e.table._element as 'funcref' | 'externref',
        initial: e.table._array.length,
    }))));
}

function inferGlobalType(value: unknown): 'i32' | 'i64' | 'f32' | 'f64' {
    if (typeof value === 'bigint') return 'i64';
    if (typeof value === 'number' && Number.isInteger(value)) return 'i32';
    return 'f64';
}

function toGlobalImportValue(value: CModuleWASM.WasmGlobalValue): number | bigint {
    if (typeof value === 'number' || typeof value === 'bigint') return value;
    throw new LinkError('WebAssembly.Global import value must be numeric');
}

// Export Creation

function createExports(
    instance: CModuleWASM.Instance,
    nativeModule: CModuleWASM.Module
): WasmExports {
    const exports = wasm.moduleExports(nativeModule);
    const result: WasmExports = {};

    for (const exp of exports) {
        switch (exp.kind) {
            case 'function': {
                const idx = wasm.getFuncIndex(instance, exp.name);
                const fn = typeof idx === 'number' && idx >= 0
                    ? wrapFuncref(instance, idx)
                    : ((...args: CModuleWASM.WasmFunctionArgument[]) =>
                        wrapWasmError(() => instance.callFunction(exp.name, ...args))) as WasmFunctionExport;
                result[exp.name] = fn;
                break;
            }
            case 'memory': {
                const mem: Memory = Object.create(Memory.prototype);
                mem._instance = instance;
                mem._buffer = null;
                mem._cachedBuffer = null;
                mem._maxPages = undefined;
                result[exp.name] = mem;
                break;
            }
            case 'table': {
                const info = wasm.getTableInfo(instance, exp.name);
                const table: Table = Object.create(Table.prototype);
                table._instance = instance;
                table._name = exp.name;
                table._element = info.element;
                table._array = [];
                table._maxSize = info.max_size || undefined;
                result[exp.name] = table;
                break;
            }
            case 'global': {
                const info = wasm.getGlobalInfo(instance, exp.name);
                const global: Global = Object.create(Global.prototype);
                global._instance = instance;
                global._name = exp.name;
                global._type = info.type;
                global._mutable = info.mutable;
                global._value = wasm.getGlobal(instance, exp.name);
                result[exp.name] = global;
                break;
            }
        }
    }

    return result;
}

// WebAssembly Global Setup

if (wasm) {
    const webAssembly: WebAssemblyFacade = {
        Module,
        Instance,
        Memory,
        Table,
        Global,
        CompileError,
        LinkError,
        RuntimeError,

        [Symbol.toStringTag]: 'WebAssembly',

        validate(bufferSource: BufferSource): boolean {
            return wasm.validate(toUint8Array(bufferSource));
        },

        compile(bufferSource: BufferSource): Promise<Module> {
            return Promise.resolve().then(() => new Module(bufferSource));
        },

        instantiate(
            source: BufferSource | Module,
            importObject?: WasmImportObject
        ): Promise<Instance | { module: Module; instance: Instance }> {
            return Promise.resolve().then(() => {
                if (source instanceof Module) {
                    return new Instance(source, importObject);
                }
                const module = new Module(source);
                const instance = new Instance(module, importObject);
                return { module, instance };
            });
        },

        async compileStreaming(source: Response | Promise<Response>): Promise<Module> {
            const response = await source;
            validateWasmMimeType(response);
            const buffer = await response.arrayBuffer();
            return new Module(buffer);
        },

        async instantiateStreaming(
            source: Response | Promise<Response>,
            importObject?: WasmImportObject
        ): Promise<{ module: Module; instance: Instance }> {
            const response = await source;
            validateWasmMimeType(response);
            const buffer = await response.arrayBuffer();
            const module = new Module(buffer);
            const instance = new Instance(module, importObject);
            return { module, instance };
        },
    };

    Reflect.set(globalThis, 'WebAssembly', webAssembly);
}

function validateWasmMimeType(response: Response): void {
    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.includes('application/wasm')) {
        throw new TypeError(
            `Invalid MIME type: expected 'application/wasm', got '${contentType}'`
        );
    }
}
