class LoaderError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
    }
}

// Lazy loader for Bun namespace
let loading = false;
Object.defineProperty(globalThis, 'Bun', {
    configurable: true,
    enumerable: true,
    get() {
        if (loading)
            throw new LoaderError('Bun global initialization is already in progress', 'ERR_BUN_GLOBAL_INITIALIZING');
        loading = true;
        try {
            const bun = require("bun:index");
            Object.defineProperty(globalThis, 'Bun', {
                value: bun,
                writable: false,
                configurable: false,
                enumerable: true,
            });
            return bun;
        } finally {
            loading = false;
        }
    },
});