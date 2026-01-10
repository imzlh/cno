import { assert } from "../utils/assert";

const wasm = import.meta.use('wasm');
if (!wasm) {
    console.warn('wasm module not found, WebAssembly is not supported');
}

Reflect.set(globalThis, 'WebAssembly', {
    ... (wasm ?? {}),
    async compileStreaming(src) {
        assert(wasm, 'WebAssembly is not supported');
        src = await src;
        const data = await src.arrayBuffer();
        return wasm.compile(data);
    },
    // @ts-ignore
    async instantiateStreaming(src, importObject) {
        assert(wasm, 'WebAssembly is not supported');
        src = await src;
        const data = await src.arrayBuffer();
        return wasm.instantiate(data, importObject);
    }
} satisfies typeof WebAssembly);
