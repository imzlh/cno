import { createServer } from "@cnojs/http/server";
import processDefault from '../process';
import { Buffer } from '../buffer';

const http = import.meta.use('evbus') && import.meta.use('http');

export interface IOpaque {
    createServer: typeof createServer;
}

// node:http/server is cache-installed and cannot import @cnojs/http, so the
// bootstrap publishes the binding on the `cno.node` evbus channel.
import.meta.use('evbus').set('cno.node', 'httpInternals', { createServer });

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
