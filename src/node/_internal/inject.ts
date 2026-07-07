import { createServer } from "@cnojs/http/server";
import processDefault from '../process';
import { Buffer } from '../buffer';

const http = import.meta.use('http');

export interface IOpaque {
    createServer: typeof createServer;
}

// http.__cno for node:http/server
const httpInternals: IOpaque = {
    createServer
};
Reflect.set(http, '__cno', httpInternals);

// global process inject
Object.defineProperties(globalThis, {
    process: {
        value: processDefault,
        writable: true,
        configurable: true,
        enumerable: true,
    },
    Buffer: {
        value: Buffer,
        writable: true,
        configurable: true,
        enumerable: true,
    },
});
