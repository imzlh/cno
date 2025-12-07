/**
 * WebAssembly polyfill for circu.js native wasm module
 * Wraps CModuleWASM to provide standard WebAssembly API
 */

const wasm = import.meta.use('wasm');

// WebAssembly Module class
class Module {
    #native: CModuleWASM.Module;

    constructor(bytes: BufferSource) {
        try {
            const buffer = bytes instanceof ArrayBuffer
                ? bytes
                : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

            this.#native = CModuleWASM.parseModule(buffer);
        } catch (error: any) {
            if (error.wasmError === 'CompileError') {
                throw new WebAssembly.CompileError(error.message);
            }
            throw error;
        }
    }

    static exports(module: Module): WebAssembly.ModuleExportDescriptor[] {
        return CModuleWASM.moduleExports(module.#native);
    }

    static imports(_module: Module): WebAssembly.ModuleImportDescriptor[] {
        return [];
    }

    static customSections(_module: Module, _sectionName: string): ArrayBuffer[] {
        return [];
    }

    get _native(): CModuleWASM.Module {
        return this.#native;
    }
}

// WebAssembly Instance class
class Instance {
    #native: CModuleWASM.Instance;
    #exports: WebAssembly.Exports;

    constructor(module: Module, _importObject?: WebAssembly.Imports) {
        try {
            this.#native = CModuleWASM.buildInstance(module._native);
            this.#exports = this.#buildExports(module);
        } catch (error: any) {
            if (error.wasmError === 'LinkError') {
                throw new WebAssembly.LinkError(error.message);
            }
            throw error;
        }
    }

    #buildExports(module: Module): WebAssembly.Exports {
        const exports: Record<string, any> = {};
        const exportList = CModuleWASM.moduleExports(module._native);

        for (const exp of exportList) {
            if (exp.kind === 'function') {
                exports[exp.name] = (...args: any[]) => {
                    try {
                        return this.#native.callFunction(exp.name, ...args);
                    } catch (error: any) {
                        if (error.wasmError === 'RuntimeError') {
                            throw new WebAssembly.RuntimeError(error.message);
                        }
                        throw error;
                    }
                };
            }
        }

        return exports;
    }

    get exports(): WebAssembly.Exports {
        return this.#exports;
    }

    /** WASI support - non-standard extension */
    linkWasi(): void {
        try {
            this.#native.linkWasi();
        } catch (error: any) {
            if (error.wasmError === 'LinkError') {
                throw new WebAssembly.LinkError(error.message);
            }
            throw error;
        }
    }
}

// Memory class (stub implementation)
class Memory {
    #buffer: ArrayBuffer;
    #initial: number;
    #maximum?: number;

    constructor(descriptor: WebAssembly.MemoryDescriptor) {
        this.#initial = descriptor.initial;
        this.#maximum = descriptor.maximum;
        this.#buffer = new ArrayBuffer(this.#initial * 65536);
    }

    get buffer(): ArrayBuffer {
        return this.#buffer;
    }

    grow(delta: number): number {
        const oldPages = this.#buffer.byteLength / 65536;
        const newPages = oldPages + delta;

        if (this.#maximum !== undefined && newPages > this.#maximum) {
            throw new RangeError('Maximum memory size exceeded');
        }

        throw new Error('Memory.grow() not supported in native wasm');
    }
}

// Table class (stub implementation)
class Table {
    #elements: any[];
    #initial: number;
    #maximum?: number;

    constructor(descriptor: WebAssembly.TableDescriptor, value?: any) {
        this.#initial = descriptor.initial;
        this.#maximum = descriptor.maximum;
        this.#elements = new Array(this.#initial).fill(value ?? null);
    }

    get length(): number {
        return this.#elements.length;
    }

    get(index: number): any {
        if (index < 0 || index >= this.#elements.length) {
            throw new RangeError('Table index out of bounds');
        }
        return this.#elements[index];
    }

    set(index: number, value: any): void {
        if (index < 0 || index >= this.#elements.length) {
            throw new RangeError('Table index out of bounds');
        }
        this.#elements[index] = value;
    }

    grow(delta: number, value?: any): number {
        const oldLength = this.#elements.length;
        const newLength = oldLength + delta;

        if (this.#maximum !== undefined && newLength > this.#maximum) {
            throw new RangeError('Table maximum size exceeded');
        }

        for (let i = 0; i < delta; i++) {
            this.#elements.push(value ?? null);
        }

        return oldLength;
    }
}

// Global class (stub implementation)
class Global {
    #value: any;
    #mutable: boolean;
    #type: string;

    constructor(descriptor: WebAssembly.GlobalDescriptor, value?: any) {
        this.#type = descriptor.value;
        this.#mutable = descriptor.mutable ?? false;
        this.#value = value ?? this.#defaultValue();
    }

    #defaultValue(): any {
        switch (this.#type) {
            case 'i32':
            case 'i64':
                return 0;
            case 'f32':
            case 'f64':
                return 0.0;
            default:
                return null;
        }
    }

    valueOf(): any {
        return this.#value;
    }

    get value(): any {
        return this.#value;
    }

    set value(v: any) {
        if (!this.#mutable) {
            throw new TypeError('Immutable global cannot be modified');
        }
        this.#value = v;
    }
}

// Error classes (use native WebAssembly errors if available)
const CompileError = globalThis.WebAssembly?.CompileError ?? class CompileError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'CompileError';
    }
};

const LinkError = globalThis.WebAssembly?.LinkError ?? class LinkError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'LinkError';
    }
};

const RuntimeError = globalThis.WebAssembly?.RuntimeError ?? class RuntimeError extends Error {
    constructor(message?: string) {
        super(message);
        this.name = 'RuntimeError';
    }
};

// API functions
function compile(bytes: BufferSource): Promise<Module> {
    return Promise.resolve(new Module(bytes));
}

function instantiate(
    source: BufferSource | Module,
    importObject?: WebAssembly.Imports
): Promise<WebAssembly.WebAssemblyInstantiatedSource | Instance> {
    return Promise.resolve().then(() => {
        if (source instanceof Module) {
            return new Instance(source, importObject);
        } else {
            const module = new Module(source);
            const instance = new Instance(module, importObject);
            return { module, instance };
        }
    });
}

function validate(bytes: BufferSource): boolean {
    try {
        const buffer = bytes instanceof ArrayBuffer
            ? bytes
            : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        CModuleWASM.parseModule(buffer);
        return true;
    } catch {
        return false;
    }
}

// Export WebAssembly namespace
export {
    Module,
    Instance,
    Memory,
    Table,
    Global,
    CompileError,
    LinkError,
    RuntimeError,
    compile,
    instantiate,
    validate
};

// Set as global WebAssembly
const WebAssemblyPolyfill = {
    Module,
    Instance,
    Memory,
    Table,
    Global,
    CompileError,
    LinkError,
    RuntimeError,
    compile,
    instantiate,
    validate
};

Object.defineProperty(globalThis, 'WebAssembly', {
    value: WebAssemblyPolyfill,
    writable: true,
    enumerable: false,
    configurable: true
});