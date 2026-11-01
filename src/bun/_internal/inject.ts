import { getCtsBridge } from '../../node/_internal/cts-bridge';

// Keep bootstrap independent of the Bun implementation and its native modules.
// Each realm resolves through its current CTS loader, not a shared Bun cache.
if (!Object.getOwnPropertyDescriptor(globalThis, 'Bun')) {
    let loading = false;
    Object.defineProperty(globalThis, 'Bun', {
        configurable: true,
        enumerable: true,
        get() {
            if (loading) {
                throw Object.assign(new Error('Bun global initialization is already in progress'), {
                    code: 'ERR_BUN_GLOBAL_INITIALIZING',
                });
            }
            const bridge = getCtsBridge();
            if (typeof bridge?.mkRequire !== 'function') {
                // Bootstrap can precede ModuleCompiler. Leave the getter intact
                // so access after CTS publishes its bridge can succeed.
                throw Object.assign(new Error('Bun global requires the CTS ModuleCompiler bridge'), {
                    code: 'ERR_CTS_BRIDGE_UNAVAILABLE',
                });
            }
            loading = true;
            try {
                const bun = bridge.mkRequire('<bun-global>')('bun');
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
}
