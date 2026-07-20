/**
 * Load the quicly Socket module.
 * Embedded: `@cnojs/quic` (CMake CNO_EMBED_EXT_QUIC).
 * Dynamic:  `ext:quic` (DEF_MODULE when built as .so).
 */

/// <reference path="../../ext-quic/native.d.ts" />

export type QuicModule = {
    Socket: typeof CModuleExternalQuic.Socket;
    constants: typeof CModuleExternalQuic.constants;
};

function isQuicModule(value: unknown): value is QuicModule {
    if (value === null || typeof value !== 'object') return false;
    const socket = Reflect.get(value, 'Socket');
    const constants = Reflect.get(value, 'constants');
    return typeof socket === 'function' && constants !== null && typeof constants === 'object';
}

let cached: QuicModule | null | undefined;
const forceUnavailableKey = Symbol.for('cno.quic.forceUnavailable');

function forceUnavailable(): boolean {
    return Reflect.get(globalThis, forceUnavailableKey) === true;
}

function tryUse(name: '@cnojs/quic' | 'ext:quic'): QuicModule | null {
    try {
        const mod = import.meta.use(name);
        return isQuicModule(mod) ? mod : null;
    } catch {
        return null;
    }
}

/** null when the native extension is not linked/loaded. */
export function tryLoadQuic(): QuicModule | null {
    if (forceUnavailable()) return null;
    if (cached !== undefined) return cached;
    const mod = tryUse('@cnojs/quic') ?? tryUse('ext:quic');
    cached = mod;
    return mod;
}

export function requireQuic(): QuicModule {
    const mod = tryLoadQuic();
    if (!mod) {
        throw new Error(
            'QUIC native extension is not available (build with -DCNO_EMBED_EXT_QUIC=ON or load ext:quic)',
        );
    }
    return mod;
}

export function quicAvailable(): boolean {
    return tryLoadQuic() !== null;
}

/**
 * Test helper: force the load gate to miss (same path as embed OFF).
 * Does not unload a linked native — only the JS gate used by surfaces.
 */
export function __forceQuicUnavailable(force: boolean): void {
    Reflect.set(globalThis, forceUnavailableKey, force);
    cached = undefined;
}
