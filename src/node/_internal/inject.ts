import { createServer } from "@cnojs/http/server";
import { Buffer } from "node-buffer";

// opaque
const engine = import.meta.use('engine');
export interface IOpaque {
    createServer: typeof createServer;
};
Reflect.set(engine, '__cno', {
    createServer
} as IOpaque);


// global process inject
let proc_cache: any;

Object.defineProperty(globalThis, 'process', {
    get() {
        if (!proc_cache) {
            proc_cache = Reflect.get(globalThis, 'require')('process');
        }

        return proc_cache;
    },
})

// inject global buffer
Reflect.set(globalThis, 'Buffer', Buffer);
