
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
    /** Native error class tag; the C layer cannot set `name` on a bare Error. */
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
        if (tag === 'RangeError' && !(e instanceof RangeError)) throw new RangeError(msg);
        if (tag === 'TypeError' && !(e instanceof TypeError)) throw new TypeError(msg);
        throw e;
    }
}

// Absent section name must yield [], not one zero-length buffer.
function customSectionsByName(module: CModuleWASM.Module, sectionName: string): ArrayBuffer[] {
    const section = module.customSections(sectionName);
    return Array.isArray(section) ? section : section ? [section] : [];
}

// Table.get returns a callable wrapper carrying its native index under this symbol.
const FUNCREF_INDEX = Symbol('wasmFuncrefIndex');
const FUNCREF_INSTANCE = Symbol('wasmFuncrefInstance');
const funcrefCache = new WeakMap<CModuleWASM.Instance, Map<number, FuncrefWrapper>>();
type FuncrefWrapper = WasmFunctionExport & {
    [FUNCREF_INDEX]: number;
    [FUNCREF_INSTANCE]: CModuleWASM.Instance;
};
type ExternKind = CModuleWASM.ModuleExportDescriptor['kind'];
type PendingExternBinding = {
    kind: 'memory' | 'table' | 'global';
    index: number;
    owner: Memory | Table | Global;
};
type ResolvedImports = {
    pendingBindings: PendingExternBinding[];
    functionDescs: CModuleWASM.ImportFunctionDescriptor[];
};

function externKey(kind: ExternKind, index: number): string {
    return `${kind}:${index}`;
}

const WASM_HEADER = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
const OWNER_EXPORT_NAME = [1, 0x78]; // "x"

function encodeULEB(value: number): number[] {
    const result: number[] = [];
    let remaining = value;
    do {
        let byte = remaining % 128;
        remaining = Math.floor(remaining / 128);
        if (remaining) byte |= 0x80;
        result.push(byte);
    } while (remaining);
    return result;
}

function encodeSLEB(value: bigint): number[] {
    const result: number[] = [];
    let remaining = value;
    while (true) {
        let byte = Number(remaining & 0x7fn);
        remaining >>= 7n;
        const sign = (byte & 0x40) !== 0;
        if ((remaining === 0n && !sign) || (remaining === -1n && sign)) {
            result.push(byte);
            return result;
        }
        byte |= 0x80;
        result.push(byte);
    }
}

function wasmSection(id: number, payload: number[]): number[] {
    return [id, ...encodeULEB(payload.length), ...payload];
}

function wasmLimits(initial: number, maximum: number | undefined): number[] {
    return maximum === undefined
        ? [0, ...encodeULEB(initial)]
        : [1, ...encodeULEB(initial), ...encodeULEB(maximum)];
}

function instantiateOwner(sections: number[][]): CModuleWASM.Instance {
    const bytes = Uint8Array.from([...WASM_HEADER, ...sections.flat()]);
    return wrapWasmError(() => wasm.load(bytes).instantiate());
}

function createMemoryOwner(initial: number, maximum: number | undefined): CModuleWASM.Instance {
    return instantiateOwner([
        wasmSection(5, [1, ...wasmLimits(initial, maximum)]),
        wasmSection(7, [1, ...OWNER_EXPORT_NAME, 2, 0]),
    ]);
}

function createTableOwner(
    element: string,
    initial: number,
    maximum: number | undefined,
): CModuleWASM.Instance {
    return instantiateOwner([
        wasmSection(4, [
            1,
            isFuncrefElement(element) ? 0x70 : 0x6f,
            ...wasmLimits(initial, maximum),
        ]),
        wasmSection(7, [1, ...OWNER_EXPORT_NAME, 1, 0]),
    ]);
}

function floatBytes(value: number, bits: 32 | 64): number[] {
    const buffer = new ArrayBuffer(bits / 8);
    const view = new DataView(buffer);
    if (bits === 32) view.setFloat32(0, value, true);
    else view.setFloat64(0, value, true);
    return [...new Uint8Array(buffer)];
}

function createGlobalOwner(
    type: string,
    mutable: boolean,
    value: CModuleWASM.WasmGlobalValue,
): CModuleWASM.Instance {
    let valueType: number;
    let initializer: number[];
    switch (type) {
        case 'i32':
            valueType = 0x7f;
            initializer = [0x41, ...encodeSLEB(BigInt(toWasmNumber(value) | 0))];
            break;
        case 'i64':
            valueType = 0x7e;
            initializer = [0x42, ...encodeSLEB(value as bigint)];
            break;
        case 'f32':
            valueType = 0x7d;
            initializer = [0x43, ...floatBytes(toWasmNumber(value), 32)];
            break;
        case 'f64':
            valueType = 0x7c;
            initializer = [0x44, ...floatBytes(toWasmNumber(value), 64)];
            break;
        default:
            throw new TypeError(`Invalid global type: '${type}'`);
    }
    return instantiateOwner([
        wasmSection(6, [1, valueType, mutable ? 1 : 0, ...initializer, 0x0b]),
        wasmSection(7, [1, ...OWNER_EXPORT_NAME, 3, 0]),
    ]);
}

/* The element type reaches this layer from two sources with different spellings:
 * a JS-constructed Table uses the descriptor's "anyfunc" (the WebAssembly JS API
 * name), while an imported/exported one is described by Instance.tableInfo(),
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
        wrapWasmError(() => instance.callByIndex(funcIndex, ...args))) as FuncrefWrapper;
    Object.defineProperty(fn, FUNCREF_INDEX, { value: funcIndex, enumerable: false });
    Object.defineProperty(fn, FUNCREF_INSTANCE, { value: instance, enumerable: false });
    cache.set(funcIndex, fn);
    return fn;
}

function isFuncrefWrapper(v: unknown): v is FuncrefWrapper {
    return typeof v === 'function' && typeof (v as FuncrefWrapper)[FUNCREF_INDEX] === 'number';
}

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

class Module {
    _native: CModuleWASM.Module;
    #bytes: ArrayBuffer;

    constructor(bufferSource: BufferSource) {
        /* Snapshot the caller's BufferSource: a compiled Module must never see
         * later writes, and non-function extern resolvers need a fresh native
         * copy per instantiation (function callbacks are instance-scoped). */
        this.#bytes = bufferSource instanceof ArrayBuffer
            ? bufferSource.slice(0)
            : toArrayBuffer(bufferSource);
        this._native = wrapWasmError(() => wasm.load(this.#bytes));
    }

    _nativeForInstantiation(): CModuleWASM.Module {
        /* Non-function extern resolvers mutate Module state; isolate them in a
         * fresh native copy so repeated instantiations stay independent. */
        return this._native.imports().some(({ kind }) => kind !== 'function')
            ? wrapWasmError(() => wasm.load(this.#bytes))
            : this._native;
    }

    static exports(module: Module): WebAssembly.ModuleExportDescriptor[] {
        /* Native descriptors carry full type info; the JS API exposes only name and kind. */
        return module._native.exports().map(({ name, kind }) => ({ name, kind }));
    }

    static imports(module: Module): WebAssembly.ModuleImportDescriptor[] {
        /* Native imports report type/link state; keep the standard shape. */
        return module._native.imports().map(({ module: moduleName, name, kind }) => ({
            module: moduleName,
            name,
            kind,
        }));
    }

    static customSections(module: Module, sectionName: string): ArrayBuffer[] {
        return customSectionsByName(module._native, sectionName);
    }
    
    get [Symbol.toStringTag]() {
        return 'WebAssembly.Module';
    }
}

class Memory {
    _instance: CModuleWASM.Instance | null;
    _index: number;
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
        this._instance = createMemoryOwner(initial, maximum);
        this._index = 0;
        this._buffer = null;
        this._cachedBuffer = null;
        this._maxPages = maximum;
    }

    private localBuffer(): ArrayBuffer {
        if (!this._buffer) throw new RuntimeError('WebAssembly.Memory buffer has been detached');
        return this._buffer;
    }

    get buffer(): ArrayBuffer {
        const instance = this._instance;
        if (instance) {
            this._cachedBuffer = wrapWasmError(() => instance.memoryBufferAt(this._index));
            return this._cachedBuffer;
        }
        return this.localBuffer();
    }

    grow(delta: number): number {
        const pages = toWasmPageCount(delta, 'delta');
        const instance = this._instance;
        if (instance) {
            const result = wrapWasmError(() => instance.growMemoryAt(this._index, pages));
            this._cachedBuffer = wrapWasmError(() => instance.memoryBufferAt(this._index));
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

const VALID_GLOBAL_TYPES = new Set(['i32', 'i64', 'f32', 'f64']);
const VALID_ELEMENT_TYPES = new Set(['anyfunc', 'funcref', 'externref']);
const MAX_TABLE_ELEMENTS = 10_000_000;

class Table {
    _instance: CModuleWASM.Instance | null;
    _index: number;
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
        this._instance = element === 'externref'
            ? createTableOwner(element, initial, maximum)
            : null;
        this._index = 0;
        this._name = this._instance ? 'x' : null;
        this._element = element;
        this._maxSize = maximum;
        this._array = this._instance ? [] : new Array(initial).fill(null);
    }

    private nativeBinding(): { instance: CModuleWASM.Instance; index: number } | null {
        if (!this._instance) return null;
        return { instance: this._instance, index: this._index };
    }

    get length(): number {
        const native = this.nativeBinding();
        if (native) return wrapWasmError(() => native.instance.tableSizeAt(native.index));
        return this._array.length;
    }

    get(index: number): CModuleWASM.WasmTableValue {
        const tableIndex = toTableIndex(index);
        const native = this.nativeBinding();
        if (native) {
            if (tableIndex >= native.instance.tableSizeAt(native.index)) {
                throw new RangeError('index out of bounds');
            }
            const raw = wrapWasmError(() => native.instance.tableGetAt(native.index, tableIndex));
            /* C returns {owner, index} for funcref slots: the defining Instance
             * travels with the function. */
            if (isFuncrefElement(this._element) && raw !== null) {
                const ref = raw as unknown as CModuleWASM.WasmFuncref;
                return wrapFuncref(ref.owner, ref.index) as unknown as CModuleWASM.WasmTableValue;
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
            if (tableIndex >= native.instance.tableSizeAt(native.index)) {
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
                toStore = value[FUNCREF_INDEX] as unknown as CModuleWASM.WasmTableValue;
            }
            wrapWasmError(() => native.instance.tableSetAt(native.index, tableIndex, toStore));
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
                && (!isFuncrefWrapper(initialValue)
                    || initialValue[FUNCREF_INSTANCE] !== native.instance)) {
                throw new TypeError('Argument 1 must be null or a WebAssembly function');
            }
            let toStore = initialValue;
            if (isFuncrefElement(this._element) && initialValue !== null) {
                const refIndex = (initialValue as FuncrefWrapper)[FUNCREF_INDEX];
                toStore = refIndex;
            }
            const grown = wrapWasmError(() => native.instance.tableGrowAt(native.index, count, toStore));
            /* WAMR reports refusal as -1; the JS API specifies a RangeError. */
            if (grown < 0) throw new RangeError('failed to grow table');
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

class Global {
    _instance: CModuleWASM.Instance | null;
    _index: number;
    _name: string | null;
    _value: CModuleWASM.WasmGlobalValue;
    _mutable: boolean;
    _type: string;

    constructor(descriptor: { value: string; mutable: boolean }, initialValue: CModuleWASM.WasmGlobalValue) {
        if (!VALID_GLOBAL_TYPES.has(descriptor.value)) {
            throw new TypeError(`Invalid global type: '${descriptor.value}'`);
        }
        validateGlobalValue(descriptor.value, initialValue);
        this._instance = createGlobalOwner(
            descriptor.value,
            descriptor.mutable,
            coerceGlobalValue(descriptor.value, initialValue),
        );
        this._index = 0;
        this._name = 'x';
        this._type = descriptor.value;
        this._mutable = descriptor.mutable;
        this._value = coerceGlobalValue(descriptor.value, initialValue);
    }

    private nativeBinding(): { instance: CModuleWASM.Instance; index: number } | null {
        if (!this._instance) return null;
        return { instance: this._instance, index: this._index };
    }

    get value(): CModuleWASM.WasmGlobalValue {
        const native = this.nativeBinding();
        if (native) return wrapWasmError(() => native.instance.getGlobalAt(native.index));
        return this._value;
    }

    set value(newValue: CModuleWASM.WasmGlobalValue) {
        if (!this._mutable) throw new TypeError('Global is immutable');
        validateGlobalValue(this._type, newValue);
        const coerced = coerceGlobalValue(this._type, newValue);
        const native = this.nativeBinding();
        if (native) {
            wrapWasmError(() => native.instance.setGlobalAt(native.index, coerced));
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

// f32 globals must read back at f32 precision (Math.fround).
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

class Instance {
    _instance: CModuleWASM.Instance;
    _exports: WasmExports;

    constructor(module: Module, importObject?: WasmImportObject) {
        const nativeModule = module._nativeForInstantiation();
        let pendingBindings: PendingExternBinding[] = [];
        let functionDescs: CModuleWASM.ImportFunctionDescriptor[] = [];
        if (importObject !== undefined && (typeof importObject !== 'object' || importObject === null)) {
            throw new TypeError('WebAssembly.Instance(): Argument 1 must be an object');
        }
        if (importObject) {
            ({ pendingBindings, functionDescs } = resolveImportObject(
                nativeModule, importObject,
            ));
        } else if (requiresImportObject(nativeModule)) {
            /* A module declaring non-WASI imports cannot be instantiated with no
             * import object. Skipping resolution entirely linked it against
             * nothing and produced a live Instance whose imported calls were
             * unbound. */
            throw new TypeError('WebAssembly.Instance(): Argument 1 must be an object');
        }
        this._instance = wrapWasmError(() => nativeModule.instantiate(
            functionDescs.length > 0 ? { functions: functionDescs } : undefined,
        ));
        for (const binding of pendingBindings) {
            binding.owner._instance = this._instance;
            binding.owner._index = binding.index;
            if (binding.kind === 'memory') {
                const memory = binding.owner as Memory;
                memory._buffer = null;
                memory._cachedBuffer = null;
            } else if (binding.kind === 'table') {
                (binding.owner as Table)._array = [];
            }
        }
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

/*
 * True when the module declares an import that an omitted import object cannot
 * satisfy. WASI modules are exempt: the runtime supplies wasi_snapshot_preview1
 * itself (see resolveImportObject), so they legitimately instantiate with none.
 */
function requiresImportObject(nativeModule: CModuleWASM.Module): boolean {
    for (const imp of nativeModule.imports()) {
        if (imp.module !== 'wasi_snapshot_preview1' && imp.module !== 'wasi_unstable') {
            return true;
        }
    }
    return false;
}

function resolveImportObject(
    nativeModule: CModuleWASM.Module,
    importObject: WasmImportObject
): ResolvedImports {
    const imports = nativeModule.imports();
    const functionDescs: CModuleWASM.ImportFunctionDescriptor[] = [];
    const globalDescs: CModuleWASM.GlobalImportDescriptor[] = [];
    const memoryDescs: ({ module: string; name: string; memory: Memory; owner: Memory }
        & Partial<CModuleWASM.MemoryImportDescriptor>)[] = [];
    const tableDescs: ({ module: string; name: string; table: Table; owner: Table }
        & Partial<CModuleWASM.TableImportDescriptor>)[] = [];
    const pendingBindings: PendingExternBinding[] = [];
    const standaloneImports = new WeakMap<object, { kind: ExternKind; index: number }>();
    let wasiSet = false;

    for (const imp of imports) {
        const isWasi = imp.module === 'wasi_snapshot_preview1' || imp.module === 'wasi_unstable';
        const moduleObj = importObject[imp.module];
        const value = moduleObj ? moduleObj[imp.name] : undefined;

        if (value === undefined) {
            if (isWasi) {
                if (!wasiSet) {
                    nativeModule.configureWasi({ args: [] });
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
                functionDescs.push({
                    module: imp.module,
                    name: imp.name,
                    func: value as CModuleWASM.ImportFunctionDescriptor['func'],
                    ...(isFuncrefWrapper(value) ? {
                        provider: value[FUNCREF_INSTANCE],
                        sourceIndex: value[FUNCREF_INDEX],
                        owner: value,
                    } : {}),
                });
                break;
            case 'global':
                if (value instanceof Global) {
                    const binding = externImportBinding(
                        value, 'global', imp.externIndex, standaloneImports,
                    );
                    globalDescs.push({
                        module: imp.module,
                        name: imp.name,
                        value: toGlobalImportValue(value.value),
                        type: value._type as CModuleWASM.GlobalImportDescriptor['type'],
                        mutable: value._mutable,
                        owner: value,
                        ...binding.descriptor,
                    });
                    if (binding.pending) pendingBindings.push(binding.pending);
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
                {
                    const { descriptor, pending } = externImportBinding(
                        value, 'memory', imp.externIndex, standaloneImports,
                    );
                    memoryDescs.push({
                        module: imp.module,
                        name: imp.name,
                        memory: value,
                        owner: value,
                        ...descriptor,
                    });
                    if (pending) pendingBindings.push(pending);
                }
                break;
            case 'table':
                if (!(value instanceof Table)) {
                    throw new LinkError(
                        `import object field '${imp.module}.${imp.name}' is not a WebAssembly.Table`
                    );
                }
                {
                    const { descriptor, pending } = externImportBinding(
                        value, 'table', imp.externIndex, standaloneImports,
                    );
                    tableDescs.push({
                        module: imp.module,
                        name: imp.name,
                        table: value,
                        owner: value,
                        ...descriptor,
                    });
                    if (pending) pendingBindings.push(pending);
                }
                break;
        }
    }

    if (globalDescs.length > 0) {
        wrapWasmError(() => nativeModule.resolveGlobals(globalDescs));
    }
    if (memoryDescs.length > 0) {
        wrapWasmError(() => nativeModule.resolveMemories(memoryDescs.map(e => ({
            ...e,
            initial: e.memory.buffer.byteLength / 65536,
            maximum: e.memory._maxPages,
        }))));
    }
    if (tableDescs.length > 0) {
        wrapWasmError(() => nativeModule.resolveTables(tableDescs.map(e => ({
            ...e,
            element: isFuncrefElement(e.table._element) ? 'funcref' : 'externref',
            initial: e.table.length,
            maximum: e.table._maxSize,
            values: e.table._instance ? undefined : e.table._array,
        }))));
    }
    return { pendingBindings, functionDescs };
}

function externImportBinding(
    owner: Memory | Table | Global,
    kind: 'memory' | 'table' | 'global',
    importIndex: number,
    standaloneImports: WeakMap<object, { kind: ExternKind; index: number }>,
): {
    descriptor: {
        provider?: CModuleWASM.Instance;
        sourceIndex?: number;
        sourceImportIndex?: number;
    };
    pending?: PendingExternBinding;
} {
    if (owner._instance) {
        return {
            descriptor: {
                provider: owner._instance,
                sourceIndex: owner._index,
            },
        };
    }
    const first = standaloneImports.get(owner);
    if (first) {
        if (first.kind !== kind) throw new LinkError('WebAssembly extern kind mismatch');
        return { descriptor: { sourceImportIndex: first.index } };
    }
    standaloneImports.set(owner, { kind, index: importIndex });
    return {
        descriptor: {},
        pending: { kind, index: importIndex, owner },
    };
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

function createExports(
    instance: CModuleWASM.Instance,
    nativeModule: CModuleWASM.Module
): WasmExports {
    const exports = nativeModule.exports();
    const result: WasmExports = {};
    const cache = new Map<string, WasmExportValue>();

    for (const exp of exports) {
        const imported = instance.importedExtern(exp.kind, exp.externIndex);
        if (imported !== undefined) {
            result[exp.name] = imported as WasmExportValue;
            cache.set(externKey(exp.kind, exp.externIndex), imported as WasmExportValue);
            continue;
        }
        const key = externKey(exp.kind, exp.externIndex);
        const cached = cache.get(key);
        if (cached) {
            result[exp.name] = cached;
            continue;
        }
        let exported: WasmExportValue;
        switch (exp.kind) {
            case 'function': {
                exported = wrapFuncref(instance, exp.externIndex);
                break;
            }
            case 'memory': {
                const mem: Memory = Object.create(Memory.prototype);
                mem._instance = instance;
                mem._index = exp.externIndex;
                mem._buffer = null;
                mem._cachedBuffer = null;
                const info = instance.memoryInfoAt(exp.externIndex);
                mem._maxPages = info.maximumPages;
                exported = mem;
                break;
            }
            case 'table': {
                const info = instance.tableInfoAt(exp.externIndex);
                const table: Table = Object.create(Table.prototype);
                table._instance = instance;
                table._index = exp.externIndex;
                table._name = exp.name;
                /* 'unknown' is the C side's funcref placeholder for bytecode
                 * tables; treat it as funcref like the cts compiler does. */
                table._element = info.element === 'unknown' ? 'funcref' : info.element;
                table._array = [];
                table._maxSize = info.max_size || undefined;
                exported = table;
                break;
            }
            case 'global': {
                const info = instance.globalInfoAt(exp.externIndex);
                const global: Global = Object.create(Global.prototype);
                global._instance = instance;
                global._index = exp.externIndex;
                global._name = exp.name;
                global._type = info.type;
                global._mutable = info.mutable;
                global._value = instance.getGlobalAt(exp.externIndex);
                exported = global;
                break;
            }
        }
        cache.set(key, exported!);
        result[exp.name] = exported!;
    }

    return result;
}

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
