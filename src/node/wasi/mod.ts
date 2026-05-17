/**
 * Node.js wasi module (stub)
 * WebAssembly System Interface
 */

export interface WASIOptions {
    args?: string[];
    env?: Record<string, string>;
    preopens?: Record<string, string>;
    returnOnExit?: boolean;
    stdin?: number;
    stdout?: number;
    stderr?: number;
}

export class WASI {
    constructor(_options?: WASIOptions) {}
    start(_instance: WebAssembly.Instance): number { return 0; }
    initialize(_instance: WebAssembly.Instance): void {}
    getImportObject(): Record<string, Record<string, Function>> { return { wasi_snapshot_preview1: {} }; }
    getImports(): Record<string, Record<string, Function>> { return { wasi_snapshot_preview1: {} }; }
}
