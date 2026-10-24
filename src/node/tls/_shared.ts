/** node:tls shared helpers and the CA trust state (`../net` + `./types` only). */

import type { Duplex } from '../stream';
import type { PromiseLikeResult, TlsCertInput, TlsKeyInput, TlsPemValue } from './types';
export { flattenPrototype } from '../_internal/prototype';
import { closeQuietly } from '../_internal/close';

const engine = import.meta.use('engine');
const os = import.meta.use('os');
const fs = import.meta.use('fs');

// Preserve the exact byte window returned by the native layer.
export function bufferFromRaw(raw: ArrayBuffer | ArrayBufferView): Buffer {
    return ArrayBuffer.isView(raw)
        ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
        : Buffer.from(raw);
}

export function normalizeAlpnProtocols(value: string[] | Buffer[] | Buffer | undefined): string[] | undefined {
    if (value === undefined) return undefined;
    // Node wire format Buffer: length-prefixed protocol list
    if (typeof value === 'object' && value !== null && !Array.isArray(value)
        && typeof (value as { length?: unknown }).length === 'number'
        && typeof (value as { subarray?: unknown }).subarray === 'function') {
        const buf = value as Buffer;
        const out: string[] = [];
        let i = 0;
        while (i < buf.length) {
            const len = buf[i]!;
            i++;
            if (i + len > buf.length) break;
            out.push(engine.decodeString(buf.subarray(i, i + len)));
            i += len;
        }
        return out.length > 0 ? out : undefined;
    }
    if (!Array.isArray(value)) return undefined;
    const list: string[] = [];
    for (const v of value) {
        if (typeof v === 'string') {
            if (v.length > 0) list.push(v);
        } else if (v && typeof (v as { byteLength?: unknown }).byteLength === 'number') {
            const s = engine.decodeString(v as Uint8Array);
            if (s.length > 0) list.push(s);
        }
    }
    return list.length > 0 ? list : undefined;
}

function pemValueToString(value: TlsPemValue | undefined): string | undefined {
    if (value === undefined) return undefined;
    return typeof value === 'string' ? value : value.toString();
}

export function keyInputToString(input: TlsKeyInput): string | undefined {
    if (typeof input === 'string' || input instanceof Buffer) return pemValueToString(input);
    return pemValueToString(input.pem ?? input.key);
}

export function certInputToString(input: TlsCertInput): string | undefined {
    if (typeof input === 'string' || input instanceof Buffer) return pemValueToString(input);
    return pemValueToString(input.pem ?? input.cert);
}

export function isPromiseLikeResult(value: unknown): value is PromiseLikeResult {
    return !!value && typeof value === 'object' && 'then' in value;
}

export function isSocketAddressStream(stream: Duplex | CModuleStreams.Stream): stream is CModuleStreams.TCP {
    return 'sockname' in stream;
}

export function callStreamMethodQuietly(stream: CModuleStreams.Stream, method: 'ref' | 'unref'): void {
    try {
        const fn = Reflect.get(stream, method);
        if (typeof fn === 'function') Reflect.apply(fn, stream, []);
    } catch {
        // Best-effort lifetime hint for native streams.
    }
}

export function shutdownSslPipeQuietly(pipe: CModuleSSL.Pipe): void {
    try {
        pipe.shutdown();
    } catch {
        // destroy() must continue cleaning up the underlying stream.
    }
}

export function closeNativeStreamQuietly(stream: CModuleStreams.Stream): void {
    closeQuietly(stream);
}

// One unit, read and written only here. Docs: docs/node-internals.md

let defaultCACertificates: string[] = [];
/** null = not probed yet; [] = probed, nothing found. */
let systemCACertificates: string[] | null = null;
let defaultCAOverridden = false;

// Synchronous (SecureContext ctor is); once. Windows OpenSSL has no usable default paths.
function loadSystemCACertificates(): string[] {
    if (systemCACertificates !== null) return systemCACertificates;
    const collected: string[] = [];

    let sysname = '';
    try {
        sysname = os.uname().sysname;
    } catch {
        // uname unavailable — fall through to the POSIX bundle probe.
    }

    if (sysname === 'Windows_NT') {
        // ROOT = trusted roots, CA = intermediates. Both belong in the store.
        for (const store of ['ROOT', 'CA']) {
            try {
                const win32 = import.meta.use('win32');
                if (win32 === null) break;	// module absent: no point trying the second store
                const certs = win32.exportCerts(store);
                if (certs?.length) collected.push(...certs);
            } catch {
                // Store unreadable or win32 module absent.
            }
        }
    } else {
        const candidates = sysname === 'Darwin'
            ? ['/etc/ssl/cert.pem', '/opt/homebrew/etc/openssl@3/cert.pem', '/usr/local/etc/openssl@3/cert.pem']
            : sysname === 'FreeBSD'
                ? ['/usr/local/share/certs/ca-root-nss.crt', '/etc/ssl/cert.pem']
                : [
                    '/etc/ssl/certs/ca-certificates.crt',
                    '/etc/pki/tls/certs/ca-bundle.crt',
                    '/etc/pki/tls/cert.pem',
                    '/etc/ssl/cert.pem',
                ];
        for (const path of candidates) {
            try {
                const bytes = fs.readFile(path);
                const text = engine.decodeString(new Uint8Array(bytes));
                if (text.includes('BEGIN CERTIFICATE')) {
                    collected.push(text);
                    break;
                }
            } catch {
                // Missing path — try the next candidate.
            }
        }
    }

    systemCACertificates = collected;
    return collected;
}

/** CA PEMs to trust when the caller supplied no explicit `ca`. */
export function effectiveDefaultCACertificates(): string[] {
    // An explicit setDefaultCACertificates() call replaces the system store,
    // matching Node, where it overrides the bundled roots.
    if (defaultCAOverridden) return defaultCACertificates;
    return loadSystemCACertificates();
}

/** POSIX bundles are concatenated; `tls.rootCertificates` needs one PEM per entry. */
function splitPemCertificates(input: string): string[] {
    const blocks: string[] = [];
    const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    for (const match of input.match(re) ?? []) blocks.push(match);
    return blocks;
}

/** Platform trust anchors, one PEM per certificate. */
export const rootCertificates: string[] = (() => {
    try {
        const collected: string[] = [];
        for (const pem of loadSystemCACertificates()) collected.push(...splitPemCertificates(pem));
        return collected;
    } catch {
        // Never let trust-store probing break `import 'node:tls'`.
        return [];
    }
})();

export function setDefaultCACertificates(certs: string[]): void {
    if (!Array.isArray(certs)) {
        throw new TypeError('The "certs" argument must be an array');
    }
    for (const cert of certs) {
        if (typeof cert !== 'string') {
            throw new TypeError('The "certs" array elements must be a string');
        }
    }
    defaultCACertificates = [...certs];
    // Explicit defaults replace, rather than extend, the system store.
    defaultCAOverridden = true;
}
