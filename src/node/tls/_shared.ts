/**
 * node:tls shared helpers plus the CA trust state: byte/PEM conversions, the
 * ALPN list normaliser, the quiet-cleanup wrappers destroy() relies on, the
 * prototype flattener the two constructor files call, and the system-store
 * cache / override set / override flag behind `setDefaultCACertificates`.
 *
 * Pulls only ../net (for the NetSocket brand check) and ./types, so both
 * ./context and ./socket can depend on it.
 */

import { Socket as NetSocket } from '../net';
import type { Duplex } from '../stream';
import type { PromiseLikeResult, TlsCertInput, TlsKeyInput, TlsPemValue } from './types';

const engine = import.meta.use('engine');
const os = import.meta.use('os');
const fs = import.meta.use('fs');

// The C layer hands back either an ArrayBuffer or a view into a larger one.
// `Buffer.from(view)` treats a view as array-like and copies *elements*, dropping
// byteOffset/byteLength — a session/ticket that is a window into a bigger buffer
// would silently decode as the wrong bytes. Copy the exact window instead.
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

// TODO: isGenericDuplexStream has no caller anywhere in the tree — it was
// already unreferenced in the single-file version. Kept as-is rather than
// deleted, since removing it is a separate cleanup, not part of this move.

export function isSocketAddressStream(stream: Duplex | CModuleStreams.Stream): stream is CModuleStreams.TCP {
    return 'sockname' in stream;
}

function isGenericDuplexStream(stream: Duplex | CModuleStreams.Stream): boolean {
    if (stream instanceof NetSocket || isSocketAddressStream(stream)) return false;
    return typeof Reflect.get(stream, 'on') === 'function'
        && typeof Reflect.get(stream, 'write') === 'function';
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
    try {
        stream.close();
    } catch {
        // destroy() is best-effort once the TLS socket is already closing.
    }
}

// Shared prototype helper (duplicated locally, same pattern as
// events/mod.ts and stream/mod.ts). MUST skip keys the target already
// defines as its own — overwriting an own override with the parent's
// version here previously caused a production hang (headers sent, body
// write silently dropped because a subclass override of a stream method
// got clobbered).
export function flattenPrototype(target: object): void {
    const parent = Object.getPrototypeOf(target);
    if (!parent || parent === Object.prototype) return;

    for (const key of Object.getOwnPropertyNames(parent)) {
        if (key === 'constructor' || Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }

    for (const key of Object.getOwnPropertySymbols(parent)) {
        if (Object.prototype.hasOwnProperty.call(target, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parent, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }
}

/**
 * node:tls CA trust state.
 *
 * The lazy system-store cache (`systemCACertificates`), the override set
 * (`defaultCACertificates`) and the override flag (`defaultCAOverridden`) are a
 * single unit: every reader and writer of them lives in this file. Duplicating
 * any one of them in another module would silently break
 * `setDefaultCACertificates()`.
 */

let defaultCACertificates: string[] = [];
/** null = not probed yet; [] = probed, nothing found. */
let systemCACertificates: string[] | null = null;
let defaultCAOverridden = false;

/**
 * Load the platform trust store, once, synchronously.
 *
 * SecureContext construction is synchronous, so this cannot await. On Windows
 * we read the OS cert stores directly; elsewhere we read the conventional
 * OpenSSL bundle paths. Without this, `verify: true` relies solely on
 * OpenSSL's compiled-in default verify paths, which on Windows point at
 * directories that do not exist — so verification failed closed against
 * every public server (see AGENT.md "TLS trust store").
 */
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

/**
 * Split PEM text into individual certificate blocks.
 *
 * The Windows stores hand back one PEM per entry, but the POSIX bundle paths
 * are a single concatenated file, and `tls.rootCertificates` is specified as
 * one string per certificate.
 */
function splitPemCertificates(input: string): string[] {
    const blocks: string[] = [];
    const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    for (const match of input.match(re) ?? []) blocks.push(match);
    return blocks;
}

/**
 * The platform trust anchors, one PEM per certificate.
 *
 * Node exposes its bundled Mozilla roots here; cno has no bundled set, so this
 * reports the platform store that `verify: true` actually uses. It was
 * previously a permanently empty array, which told callers no trust anchors
 * existed while the store held dozens.
 */
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
    // Without this the override flag stayed false forever, so
    // effectiveDefaultCACertificates() would keep returning the system store
    // and silently ignore the caller's replacement set.
    defaultCAOverridden = true;
}
