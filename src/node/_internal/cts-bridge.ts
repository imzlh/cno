const NAMESPACE = 'cts.internal';
const BRIDGE_KEY = 'bridge';
const BRIDGE_READY = 'bridge-ready';
const LEGACY_SLOT = Symbol.for('cts.internal');

type Bridge = Record<string, unknown>;
type Registry = Pick<typeof CModuleEvBus, 'get' | 'set'> & Partial<Pick<typeof CModuleEvBus, 'on'>>;

const evbus: Registry | undefined = (() => {
    try {
        const bus = import.meta.use('evbus');
        return bus && typeof bus.get === 'function' && typeof bus.set === 'function' ? bus : undefined;
    } catch {
        return undefined;
    }
})();

function isBridge(value: unknown): value is Bridge {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
}

export function getCtsBridge(): Bridge | undefined {
    const shared = evbus?.get(NAMESPACE, BRIDGE_KEY);
    if (isBridge(shared)) return shared;
    try {
        const legacy: unknown = Reflect.get(globalThis, LEGACY_SLOT);
        return isBridge(legacy) ? legacy : undefined;
    } catch {
        return undefined;
    }
}

export function registerNodeModuleInterop(register: (interop: Bridge) => void): void {
    const existing = getCtsBridge()?.nodeModuleInterop;
    if (isBridge(existing)) {
        register(existing);
        return;
    }
    if (!evbus?.on) return;

    // A sandbox may load CNO before CTS. Do not make that short-lived realm
    // own the shared bridge; wait for CTS to publish it instead.
    const off = evbus.on(NAMESPACE, BRIDGE_READY, value => {
        if (!isBridge(value) || !isBridge(value.nodeModuleInterop)) return;
        off();
        register(value.nodeModuleInterop);
    });
}
