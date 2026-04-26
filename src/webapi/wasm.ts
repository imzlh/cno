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

const wasm = import.meta.use('wasm')!;

type BufferSource = ArrayBuffer | ArrayBufferView;

function toArrayBuffer(source: BufferSource): ArrayBuffer {
    if (source instanceof ArrayBuffer) return source;
    const ret = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    if (ret instanceof SharedArrayBuffer)
        throw new TypeError('SharedArrayBuffer is not supported');
    return ret;
}

function wrapWasmError<T>(fn: () => T): T {
    try {
        return fn();
    } catch (e: any) {
        const msg = e?.message || String(e);
        const name = String(e?.name || e?.code || '');
        if (name.includes('Compile')) throw new CompileError(msg);
        if (name.includes('Link')) throw new LinkError(msg);
        if (name.includes('Runtime')) throw new RuntimeError(msg);
        throw e;
    }
}

// ============================================================================
// Error Classes
// ============================================================================

class CompileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CompileError';
    }
}

class LinkError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LinkError';
    }
}

class RuntimeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RuntimeError';
    }
}

// ============================================================================
// Module
// ============================================================================

class Module {
    _native: CModuleWASM.Module;

    constructor(bufferSource: BufferSource) {
        this._native = wrapWasmError(() => wasm.parseModule(toArrayBuffer(bufferSource)));
    }

    static exports(module: Module): WebAssembly.ModuleExportDescriptor[] {
        return wasm.moduleExports(module._native) as any;
    }

    static imports(module: Module): WebAssembly.ModuleImportDescriptor[] {
        return wasm.moduleImports(module._native) as any;
    }

    static customSections(_module: Module, _sectionName: string): ArrayBuffer[] {
        return [];
    }
}

// ============================================================================
// Memory
// ============================================================================

class Memory {
    _instance: CModuleWASM.Instance | null;
    _buffer: ArrayBuffer | null;
    _maxPages: number | undefined;

    constructor(descriptor: { initial: number; maximum?: number; shared?: boolean }) {
        this._instance = null;
        this._buffer = new ArrayBuffer(descriptor.initial * 65536);
        this._maxPages = descriptor.maximum;
    }

    get buffer(): ArrayBuffer {
        if (this._instance) return wasm.getMemoryBuffer(this._instance);
        return this._buffer!;
    }

    grow(delta: number): number {
        if (this._instance) {
            return wrapWasmError(() => wasm.growMemory(this._instance!, delta));
        }
        const oldPages = this._buffer!.byteLength / 65536;
        const newPages = oldPages + delta;
        if (this._maxPages !== undefined && newPages > this._maxPages) return -1;
        const newBuffer = new ArrayBuffer(newPages * 65536);
        new Uint8Array(newBuffer).set(new Uint8Array(this._buffer!));
        this._buffer = newBuffer;
        return oldPages;
    }
}

// ============================================================================
// Table
// ============================================================================

class Table {
    _instance: CModuleWASM.Instance | null;
    _name: string | null;
    _element: string;
    _array: (number | null | unknown)[];
    _maxSize: number | undefined;

    constructor(descriptor: { element: string; initial: number; maximum?: number }) {
        this._instance = null;
        this._name = null;
        this._element = descriptor.element;
        this._maxSize = descriptor.maximum;
        this._array = new Array(descriptor.initial).fill(null);
    }

    get length(): number {
        if (this._instance) return wasm.tableSize(this._instance, this._name!);
        return this._array.length;
    }

    get(index: number): any {
        if (this._instance) return wasm.tableGet(this._instance, this._name!, index);
        return index < this._array.length ? this._array[index] : undefined;
    }

    set(index: number, value: any): void {
        if (this._instance) {
            wasm.tableSet(this._instance, this._name!, index, value);
            return;
        }
        this._array[index] = value;
    }

    grow(delta: number, init?: any): number {
        if (this._instance) return wasm.tableGrow(this._instance, this._name!, delta);
        const oldLength = this._array.length;
        const newLength = oldLength + delta;
        if (this._maxSize !== undefined && newLength > this._maxSize) return -1;
        for (let i = 0; i < delta; i++) {
            this._array.push(init ?? null);
        }
        return oldLength;
    }
}

// ============================================================================
// Global
// ============================================================================

class Global {
    _instance: CModuleWASM.Instance | null;
    _name: string | null;
    _value: CModuleWASM.WasmValue;
    _mutable: boolean;
    _type: string;

    constructor(descriptor: { value: string; mutable: boolean }, initialValue: CModuleWASM.WasmValue) {
        this._instance = null;
        this._name = null;
        this._type = descriptor.value;
        this._mutable = descriptor.mutable;
        this._value = initialValue;
    }

    get value(): CModuleWASM.WasmValue {
        if (this._instance) return wasm.getGlobal(this._instance, this._name!);
        return this._value;
    }

    set value(newValue: CModuleWASM.WasmValue) {
        if (!this._mutable) throw new TypeError('Global is immutable');
        if (this._instance) {
            wasm.setGlobal(this._instance, this._name!, newValue);
            return;
        }
        this._value = newValue;
    }

    valueOf(): CModuleWASM.WasmValue {
        return this.value;
    }
}

// ============================================================================
// Instance
// ============================================================================

class Instance {
    _instance: CModuleWASM.Instance;
    _exports: Record<string, any>;

    constructor(module: Module, importObject?: Record<string, Record<string, any>>) {
        const nativeModule = module._native;
        if (importObject) {
            resolveImportObject(nativeModule, importObject);
        }
        this._instance = wrapWasmError(() => wasm.buildInstance(nativeModule));
        this._exports = createExports(this._instance, nativeModule);
    }

    get exports(): Record<string, any> {
        return this._exports;
    }
}

// ============================================================================
// Import Resolution
// ============================================================================

function resolveImportObject(
    nativeModule: CModuleWASM.Module,
    importObject: Record<string, Record<string, any>>
): void {
    const imports = wasm.moduleImports(nativeModule);
    const functionDescs: CModuleWASM.ImportFunctionDescriptor[] = [];
    const globalDescs: CModuleWASM.GlobalImportDescriptor[] = [];
    let wasiSet = false;

    for (const imp of imports) {
        const moduleObj = importObject[imp.module];
        if (!moduleObj) {
            if (imp.module === 'wasi_snapshot_preview1' || imp.module === 'wasi_unstable') {
                if (!wasiSet) {
                    wasm.setWasiOptions(nativeModule, [], null, null);
                    wasiSet = true;
                }
            }
            continue;
        }
        const value = moduleObj[imp.name];
        if (value === undefined) {
            if (imp.module === 'wasi_snapshot_preview1' || imp.module === 'wasi_unstable') {
                if (!wasiSet) {
                    wasm.setWasiOptions(nativeModule, [], null, null);
                    wasiSet = true;
                }
            }
            continue;
        }

        switch (imp.kind) {
            case 'function':
                if (typeof value === 'function') {
                    functionDescs.push({ module: imp.module, name: imp.name, func: value });
                }
                break;
            case 'global':
                if (value instanceof Global) {
                    globalDescs.push({
                        module: imp.module,
                        name: imp.name,
                        value: value._value,
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
                break;
            case 'table':
                break;
        }
    }

    if (functionDescs.length > 0) {
        wrapWasmError(() => wasm.resolveImports(nativeModule, functionDescs));
    }
    if (globalDescs.length > 0) {
        wrapWasmError(() => wasm.resolveGlobalImports(nativeModule, globalDescs));
    }
}

function inferGlobalType(value: any): 'i32' | 'i64' | 'f32' | 'f64' {
    if (typeof value === 'bigint') return 'i64';
    if (Number.isInteger(value)) return 'i32';
    return 'f64';
}

// ============================================================================
// Export Creation
// ============================================================================

function createExports(
    instance: CModuleWASM.Instance,
    nativeModule: CModuleWASM.Module
): Record<string, any> {
    const exports = wasm.moduleExports(nativeModule);
    const result: Record<string, any> = {};

    for (const exp of exports) {
        switch (exp.kind) {
            case 'function':
                result[exp.name] = (...args: CModuleWASM.WasmValue[]) => {
                    return wrapWasmError(() => instance.callFunction(exp.name, ...args));
                };
                break;
            case 'memory': {
                const mem = Object.create(Memory.prototype) as Memory;
                mem._instance = instance;
                mem._buffer = null;
                mem._maxPages = undefined;
                result[exp.name] = mem;
                break;
            }
            case 'table': {
                const info = wasm.getTableInfo(instance, exp.name);
                const table = Object.create(Table.prototype) as Table;
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
                const global = Object.create(Global.prototype) as Global;
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

// ============================================================================
// WebAssembly Global Setup
// ============================================================================

if (wasm) {
    globalThis.WebAssembly = {
        Module,
        Instance,
        Memory,
        Table,
        Global,
        CompileError,
        LinkError,
        RuntimeError,

        validate(bufferSource: BufferSource): boolean {
            return wasm.validate(toArrayBuffer(bufferSource));
        },

        compile(bufferSource: BufferSource): Promise<Module> {
            return Promise.resolve().then(() => new Module(bufferSource));
        },

        instantiate(
            source: BufferSource | Module,
            importObject?: Record<string, Record<string, any>>
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
            const buffer = await (await source).arrayBuffer();
            return new Module(buffer);
        },

        async instantiateStreaming(
            source: Response | Promise<Response>,
            importObject?: Record<string, Record<string, any>>
        ): Promise<{ module: Module; instance: Instance }> {
            const buffer = await (await source).arrayBuffer();
            const module = new Module(buffer);
            const instance = new Instance(module, importObject);
            return { module, instance };
        },
    } as any;
}
