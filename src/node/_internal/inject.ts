let process: NodeJS.Process;
Object.defineProperty(globalThis, 'process', {
    get() {
        if (!process) {
            process = require('process').process;
        }

        return process;
    },
})