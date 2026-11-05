import { createServer } from "@cnojs/http/server";
import processDefault from '../process';
// The relative path is required: inject is bundled into the main blob where
// the node:buffer specifier is unavailable at bundle time. The runtime
// node:buffer protocol compiles the same source separately, so the global
// class and the module class are distinct evaluations until the builtin
// registry can hand out the blob's instance (tracked in the plan doc).
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
