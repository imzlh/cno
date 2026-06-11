import { createServer } from "@cnojs/http/server";

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
            proc_cache = require('process').process;
        }

        return proc_cache;
    },
})