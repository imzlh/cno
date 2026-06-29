import { createServer } from "@cnojs/http/server";

const http = import.meta.use('http');

export interface IOpaque {
    createServer: typeof createServer;
}

// http.__cno for node:http/server
Reflect.set(http, '__cno', {
    createServer
} as IOpaque);

// global process inject
let proc_cache: any;
let buffer_cache: any;

Object.defineProperties(globalThis, {
    process: {
        get() {
            if (!proc_cache) {
                proc_cache = Reflect.get(globalThis, 'require')('process');
            }

            return proc_cache;
        },
    },
    Buffer: {
        get() {
            if (!buffer_cache) {
                buffer_cache = Reflect.get(globalThis, 'require')('buffer').Buffer;
            }
            return buffer_cache;
        },
    },
});
