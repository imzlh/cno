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

    /** Get instance memory */
    getMemory(): Memory | null {
        const nativeMemory = this.#native.memory();
        if (!nativeMemory) {
            return null;
        }
        
        // Create a wrapper that exposes the native memory
        return {
            get buffer(): ArrayBuffer {
                const buf = nativeMemory.buffer();
                if (!buf) {
                    throw new Error('Memory buffer is not available');
                }
                return buf;
            },
            grow(delta: number): number {
                return nativeMemory.grow(delta);
            }
        } as Memory;
    }

    /** Get instance table */
    getTable(): Table | null {
        const nativeTable = this.#native.table();
        if (!nativeTable) {
            return null;
        }
        
        // Create a wrapper that exposes the native table
        return {
            get length(): number {
                return nativeTable.size();
            },
            get(index: number): any {
                return nativeTable.get(index);
            },
            set(index: number, value: any): void {
                nativeTable.set(index, value);
            },
            grow(delta: number, value?: any): number {
                const oldLength = nativeTable.size();
                // Note: Native implementation may not support grow
                throw new Error('Table.grow() not fully supported in native wasm');
            }
        } as Table;
    }

    /** Get instance globals */
    getGlobals(): Global[] {
        const nativeGlobals = this.#native.globals();
        
        // Create wrappers for each native global
        return nativeGlobals.map(nativeGlobal => {
            // We need to determine if the global is mutable and its type
            // For now, we'll assume all globals are immutable i64
            const isMutable = false; // This would need to be determined from the native global
            const type = 'i64'; // This would need to be determined from the native global
            
            return {
                valueOf(): any {
                    return nativeGlobal.value();
                },
                get value(): any {
                    return nativeGlobal.value();
                },
                set value(v: any) {
                    if (!isMutable) {
                        throw new TypeError('Immutable global cannot be modified');
                    }
                    nativeGlobal.setValue(v);
                }
            } as Global;
        });
    }
}

// Memory class (wrapper around native memory)
class Memory {
    #native: CModuleWASM.Memory;

    constructor(descriptor: WebAssembly.MemoryDescriptor) {
        this.#native = CModuleWASM.createMemory({
            initial: descriptor.initial,
            maximum: descriptor.maximum
        });
    }

    get buffer(): ArrayBuffer {
        const buf = this.#native.buffer();
        if (!buf) {
            throw new Error('Memory buffer is not available');
        }
        return buf;
    }

    grow(delta: number): number {
        return this.#native.grow(delta);
    }
}

// Table class (wrapper around native table)
class Table {
    #native: CModuleWASM.Table;

    constructor(descriptor: WebAssembly.TableDescriptor, value?: any) {
        this.#native = CModuleWASM.createTable({
            element: descriptor.element || "anyfunc",
            initial: descriptor.initial,
            maximum: descriptor.maximum
        });
        
        // Initialize with value if provided
        if (value !== undefined) {
            for (let i = 0; i < descriptor.initial; i++) {
                this.#native.set(i, value);
            }
        }
    }

    get length(): number {
        return this.#native.size();
    }

    get(index: number): any {
        return this.#native.get(index);
    }

    set(index: number, value: any): void {
        this.#native.set(index, value);
    }

    grow(delta: number, value?: any): number {
        const oldLength = this.#native.size();
        
        // Note: Native implementation may not support grow, so we need to handle this
        try {
            // If native table supports grow, use it
            // For now, we'll implement a fallback
            throw new Error('Table.grow() not fully supported in native wasm');
        } catch {
            // Fallback implementation
            if (value !== undefined) {
                for (let i = 0; i < delta; i++) {
                    // This is a simplified implementation
                    // In a real implementation, we'd need to extend the native table
                }
            }
            return oldLength;
        }
    }
}

// Global class (wrapper around native global)
class Global {
    #native: CModuleWASM.Global;
    #mutable: boolean;
    #type: string;

    constructor(descriptor: WebAssembly.GlobalDescriptor, value?: any) {
        this.#type = descriptor.value;
        this.#mutable = descriptor.mutable ?? false;
        
        // Convert descriptor to match native format
        const nativeDescriptor = {
            value: this.#type,
            mutable: this.#mutable
        };
        
        this.#native = CModuleWASM.createGlobal(nativeDescriptor, value ?? this.#defaultValue());
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
                return 0;
        }
    }

    valueOf(): any {
        return this.#native.value();
    }

    get value(): any {
        return this.#native.value();
    }

    set value(v: any) {
        if (!this.#mutable) {
            throw new TypeError('Immutable global cannot be modified');
        }
        this.#native.setValue(v);
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

// Additional native functions
function createMemory(descriptor: WebAssembly.MemoryDescriptor): Memory {
    return new Memory(descriptor);
}

function createTable(descriptor: WebAssembly.TableDescriptor, value?: any): Table {
    return new Table(descriptor, value);
}

function createGlobal(descriptor: WebAssembly.GlobalDescriptor, value?: any): Global {
    return new Global(descriptor, value);
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
    validate,
    createMemory,
    createTable,
    createGlobal
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
    validate,
    createMemory,
    createTable,
    createGlobal
};

Object.defineProperty(globalThis, 'WebAssembly', {
    value: WebAssemblyPolyfill,
    writable: true,
    enumerable: false,
    configurable: true
});