/**
 * WebAssembly JavaScript API Polyfill for txiki.js
 *
 * Bridges the synchronous WAMR C backend to the standard WebAssembly global,
 * adding the streaming variants that fetch + compile/instantiate from a Response.
 *
 * @see {@link https://webassembly.github.io/spec/js-api/}
 */

import { assert } from "../utils/assert";

const wasm = import.meta.use('wasm')!;
assert(wasm, 'WAMR runtime not available');

// @ts-ignore
globalThis.WebAssembly = {
    ...wasm,

    async compileStreaming(source: Response | Promise<Response>): Promise<CModuleWASM.Module> {
        const buffer = await (await source).arrayBuffer();
        return wasm.compile(buffer);
    },

    // @ts-ignore
    async instantiateStreaming(
        source: Response | PromiseLike<Response>,
        importObject?: CModuleWASM.ImportObject
    ): Promise<{ module: CModuleWASM.Module; instance: CModuleWASM.Instance }> {
        const buffer = await (await source).arrayBuffer();
        const module = wasm.compile(buffer);
        const instance = new wasm.Instance(module, importObject);
        return { module, instance };
    },
};