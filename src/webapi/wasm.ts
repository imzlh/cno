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
        const name = String(record?.name || record?.code || '');
        if (name.includes('Compile')) throw new CompileError(msg);
        if (name.includes('Link')) throw new LinkError(msg);
        if (name.includes('Runtime')) throw new RuntimeError(msg);
        throw e;
    }
}

function requireCustomSection(module: CModuleWASM.Module, sectionName: string): ArrayBuffer {
    const section = wasm.moduleCustomSections(module, sectionName);
    return section ?? new ArrayBuffer(0);
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
        return [requireCustomSection(module._native, sectionName)];
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
        this._instance = null;
        this._buffer = new ArrayBuffer(descriptor.initial * 65536);
        this._cachedBuffer = this._buffer;
        this._maxPages = descriptor.maximum;
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
        const instance = this._instance;
        if (instance) {
            const result = wrapWasmError(() => wasm.growMemory(instance, delta));
            this._cachedBuffer = wasm.getMemoryBuffer(instance);
            return result;
        }
        const oldBuffer = this.localBuffer();
        const oldPages = oldBuffer.byteLength / 65536;
        const newPages = oldPages + delta;
        if (this._maxPages !== undefined && newPages > this._maxPages) return -1;
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

// Table

const VALID_GLOBAL_TYPES = new Set(['i32', 'i64', 'f32', 'f64']);
const VALID_ELEMENT_TYPES = new Set(['anyfunc', 'funcref', 'externref']);

class Table {
    _instance: CModuleWASM.Instance | null;
    _name: string | null;
    _element: string;
    _array: CModuleWASM.WasmTableValue[];
    _maxSize: number | undefined;

    constructor(descriptor: { element: string; initial: number; maximum?: number }) {
        if (!VALID_ELEMENT_TYPES.has(descriptor.element)) {
            throw new TypeError(`Invalid table element type: '${descriptor.element}'`);
        }
        this._instance = null;
        this._name = null;
        this._element = descriptor.element;
        this._maxSize = descriptor.maximum;
        this._array = new Array(descriptor.initial).fill(null);
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
        const native = this.nativeBinding();
        if (native) {
            if (index >= wasm.tableSize(native.instance, native.name)) {
                throw new RangeError('index out of bounds');
            }
            return wasm.tableGet(native.instance, native.name, index);
        }
        if (index >= this._array.length) {
            throw new RangeError('index out of bounds');
        }
        return this._array[index];
    }

    set(index: number, value: CModuleWASM.WasmTableValue): void {
        const native = this.nativeBinding();
        if (native) {
            if (index >= wasm.tableSize(native.instance, native.name)) {
                throw new RangeError('index out of bounds');
            }
            wasm.tableSet(native.instance, native.name, index, value);
            return;
        }
        if (index >= this._array.length) {
            throw new RangeError('index out of bounds');
        }
        this._array[index] = value;
    }

    grow(delta: number, init?: CModuleWASM.WasmTableValue): number {
        const native = this.nativeBinding();
        if (native) return wasm.tableGrow(native.instance, native.name, delta);
        const oldLength = this._array.length;
        const newLength = oldLength + delta;
        if (this._maxSize !== undefined && newLength > this._maxSize) return -1;
        for (let i = 0; i < delta; i++) {
            this._array.push(init ?? null);
        }
        return oldLength;
    }
    
    get [Symbol.toStringTag]() {
        return 'WebAssembly.Table';
    }
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
        this._value = initialValue;
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
        const native = this.nativeBinding();
        if (native) {
            wasm.setGlobal(native.instance, native.name, newValue);
            return;
        }
        this._value = newValue;
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
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                throw new TypeError('Global value must be an integer for i32 type');
            }
            break;
        case 'i64':
            if (typeof value !== 'bigint') {
                throw new TypeError('Global value must be a BigInt for i64 type');
            }
            break;
        case 'f32':
        case 'f64':
            if (typeof value !== 'number') {
                throw new TypeError('Global value must be a number for f32/f64 type');
            }
            break;
    }
}

// Instance

class Instance {
    _instance: CModuleWASM.Instance;
    _exports: WasmExports;

    constructor(module: Module, importObject?: WasmImportObject) {
        const nativeModule = module._native;
        if (importObject) {
            resolveImportObject(nativeModule, importObject);
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
            case 'function':
                result[exp.name] = (...args: CModuleWASM.WasmFunctionArgument[]) => {
                    return wrapWasmError(() => instance.callFunction(exp.name, ...args));
                };
                break;
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
