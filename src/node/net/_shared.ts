/**
 * node:net internal utilities shared by ./socket, ./server and ./blocklist.
 *
 * Socket-option setters, quiet-cleanup wrappers, the listen-error shaper, the
 * nextTick deferral helpers, port validation / address-family normalisation /
 * connect-time DNS resolution, and the IP-literal utilities.
 *
 * Only `isIP` / `isIPv4` / `isIPv6` are part of the public `node:net` surface —
 * mod.ts deliberately re-exports nothing else from here.
 */

const nativeError = import.meta.use('error');
const os = import.meta.use('os');
const nativeDns = import.meta.use('dns');

import type { EventEmitter } from '../events';
import { normalizeErrnoError } from '../_internal/errno';
export { flattenPrototype } from '../_internal/prototype';
import type { Server, Socket, TcpNetConnectOpts, UpgradeHandle } from './types';

export function normalizeTcpHost(host: string): string {
    if (!host || host === '*') return '0.0.0.0';
    if (host === 'localhost') return '127.0.0.1';
    return host;
}

export function isUnsupportedSocketOption(error: unknown): boolean {
    return String(error && typeof error === 'object' && 'message' in error ? error.message : error)
        .includes('Not implemented');
}

export function isInvalidArgument(error: unknown): boolean {
    return String(error && typeof error === 'object' && 'message' in error ? error.message : error)
        .includes('EINVAL');
}

export function setTcpNoDelay(tcp: CModuleStreams.TCP, enabled: boolean): void {
    try { tcp.setNoDelay(enabled); }
    catch (error) { if (!isUnsupportedSocketOption(error)) throw error; }
}

export function keepAliveDelayToSeconds(delayMs: number): number {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return 0;
    return Math.max(1, Math.ceil(delayMs / 1000));
}

export function setTcpKeepAlive(tcp: CModuleStreams.TCP, enabled: boolean, delayMs: number): void {
    const delay = enabled ? keepAliveDelayToSeconds(delayMs) : 0;
    try { tcp.setKeepAlive(enabled, delay); }
    catch (error) {
        if (isUnsupportedSocketOption(error)) return;
        // libuv rejects uv_tcp_keepalive(enable=1, delay=0) with EINVAL on
        // Windows. Node hands the same 0 to the same libuv call and ignores its
        // return value, so `socket.setKeepAlive()` / `setKeepAlive(true)` — both
        // of which mean "delay 0" — are observable no-ops there rather than
        // throws. Throwing breaks the single most common call form, so match
        // node and swallow exactly that case.
        if (enabled && delay === 0 && isInvalidArgument(error)) return;
        throw error;
    }
}

export function stopPipeReadQuietly(pipe: CModuleStreams.Pipe): void {
    try {
        pipe.stopRead();
    } catch {
        // Ignore best-effort cleanup failures.
    }
}

export function closeTcpQuietly(tcp: CModuleStreams.TCP): void {
    try {
        tcp.close();
    } catch {
        // Ignore best-effort cleanup failures.
    }
}

export function closePipeQuietly(pipe: CModuleStreams.Pipe): void {
    try {
        pipe.close();
    } catch {
        // Ignore best-effort cleanup failures.
    }
}

export function closeUpgradeHandleQuietly(handle: UpgradeHandle): void {
    try {
        handle.close();
    } catch {
        // Ignore best-effort cleanup failures.
    }
}

export function emitErrorQuietly(emitter: EventEmitter, error: Error): void {
    try {
        emitter.emit('error', error);
    } catch {
        // Preserve destroy() cleanup even if an error listener throws.
    }
}

// Node's bind/listen failures carry `syscall:'listen'` plus the address that
// failed, and the message is `listen <CODE>: <desc> <address>[:<port>]`.
// Verified against real Node v24.18 on Windows:
//   listen EADDRINUSE: address already in use 127.0.0.1:49625
//   listen EACCES: permission denied C:\...\x.sock
export function toListenError(raw: unknown, address: string, port?: number): Error {
    const err = normalizeErrnoError(raw, 'listen') as NodeJS.ErrnoException & {
        address?: string;
        port?: number;
    };
    const code = typeof err.code === 'string' ? err.code : 'UNKNOWN';
    let desc = typeof err.errno === 'number' ? nativeError.strerror(err.errno) : '';
    if (!desc) desc = err.message;
    // strerror/message already carry a `CODE: ` prefix; keep the readable half.
    desc = desc.replace(/^[A-Z][A-Z0-9]*:\s*/, '').trim() || 'unknown error';
    const where = port === undefined ? address : `${address}:${port}`;
    err.message = `listen ${code}: ${desc}${where ? ` ${where}` : ''}`;
    err.syscall = 'listen';
    err.address = address;
    if (port !== undefined) err.port = port;
    // toErrnoException stamps an own `name`; Node's listen errors do not carry
    // one, so `Object.keys(err)` would otherwise not match upstream.
    delete (err as { name?: string }).name;
    return err;
}

// A read error is fatal in Node: `onStreamRead` calls `destroy(err)`, which
// emits 'error' once and then 'close' with hadError=true. Emitting bare and
// leaving the socket open was measured to produce, on a peer RST mid-write:
//   cno: 35 'error' emissions, later ones raw native IOError objects whose
//        `.code` is the NUMBER -4047 and which carry no own properties, and
//        NO 'close' at all — `destroyed` stayed false, readyState 'open'.
//   node: exactly 1 error (code 'ECONNRESET', string) then close(hadError=true).
// A `err.code === 'ECONNRESET'` check — the standard idiom — silently fails
// against a numeric code, so the repeats were also unclassifiable.
export function destroyWithReadError(socket: Socket, raw: unknown): void {
    if (socket._destroyed) return;
    socket.destroy(normalizeErrnoError(raw, 'read'));
}

// Node runs 'listening' / listen-error emissions on the next tick so that
// `server.listen(p); server.on('listening'|'error', h)` — the standard idiom —
// still observes them. `process` is resolved lazily to avoid an import cycle
// (same approach as stream/mod.ts's deferTick).
type NextTickHost = { nextTick?: (callback: () => void, ...args: unknown[]) => void };

export function deferTick(callback: () => void): void {
    const host = (globalThis as { process?: NextTickHost }).process;
    if (host && typeof host.nextTick === 'function') {
        host.nextTick(callback);
        return;
    }
    queueMicrotask(callback);
}

// Node defers listen failures to nextTick, so `server.listen(p);
// server.on('error', h)` still catches them. Emitting inline instead makes that
// idiom (the standard EADDRINUSE retry) throw out of listen().
export function emitListenErrorAsync(server: Server, err: Error): void {
    deferTick(() => emitErrorQuietly(server, err));
}

// Measured against real Node v24.18: `listen()` NEVER emits 'listening' inline.
//   listen(0):              AFTER-listen() listening=true > listening-event > listen-cb > nextTick
//   listen(0,'127.0.0.1'):  AFTER-listen() listening=false > microtask > nextTick > listening-event
// Emitting inline broke two things:
//   1. `server.listen(p); server.on('listening', h)` never fired h at all — the
//      event was already gone by the time the listener attached.
//   2. A listen callback that calls `server.close()` ran *inside* listen(),
//      which tripped a C-level bug where a handle closed from within another
//      handle's close-callback delivery does not hold the loop alive, so the
//      close callback was silently dropped and the process exited early.
export function emitListeningAsync(server: Server): void {
    deferTick(() => {
        // close() between listen() and this tick means Node never emits.
        if (!server._listening) return;
        server.emit('listening');
    });
}

// Flattens a prototype chain onto `target` for interop with consumers that
// expect a single-level prototype (e.g. some npm packages walk own
// properties). Must never clobber a property `target` already defines as its
// own — doing so silently overwrites intentional subclass overrides with the
// parent's version (see stream/mod.ts's flattenPrototype for the incident
// this guards against: Readable.prototype.on/once auto-resume overrides were
// being clobbered by a naive flatten call, hanging every HTTP response body).
// ---------------------------------------------------------------------------
// Port validation, address-family normalisation, and connect-time DNS
// resolution. Internal to the net module — not re-exported from mod.ts.
// ---------------------------------------------------------------------------

type ResolvedConnectAddress = { address: string; family: 4 | 6 };

export function normalizeFamily(value: unknown): 0 | 4 | 6 {
    if (value === undefined || value === 0) return 0;
    if (value === 4 || value === 'IPv4') return 4;
    if (value === 6 || value === 'IPv6') return 6;
    throw new TypeError(`The "family" option must be 0, 4, 6, "IPv4", or "IPv6". Received ${String(value)}`);
}

// Node's ERR_SOCKET_BAD_PORT text. Its `determineSpecificType` quotes strings and
// reports the RAW value, so a numeric string stays `type string ('99999')` and is
// NOT coerced to a number first. Measured v24.18.0.
export function badPortError(value: unknown, name: string): RangeError {
    const shown = typeof value === 'string' ? `'${value}'` : String(value);
    return Object.assign(
        new RangeError(`${name} should be >= 0 and < 65536. Received type ${typeof value} (${shown}).`),
        { code: 'ERR_SOCKET_BAD_PORT' },
    );
}

export function validatePort(value: unknown, name = 'Port'): number {
    // Node's validatePort accepts a numeric string and returns `port | 0`, which is
    // why `net.connect({ port: '8080' })` works there. undici passes the port through
    // from URL parsing, where it is a string.
    const bad = (typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && value.trim().length === 0)
        || +value !== (+value >>> 0)
        || +value > 0xFFFF;
    if (bad) {
        // Was a bare RangeError with no `.code`: a package branching on
        // `err.code === 'ERR_SOCKET_BAD_PORT'` saw undefined and fell through to
        // whatever its generic handler did. Node's default `name` is 'Port'.
        throw badPortError(value, name);
    }
    return +value | 0;
}

export function abortError(): Error & { code: string; name: string } {
    const error = new Error('The operation was aborted') as Error & { code: string; name: string };
    error.code = 'ABORT_ERR';
    error.name = 'AbortError';
    return error;
}

export function resolveConnectAddress(hostname: string, options: TcpNetConnectOpts): Promise<ResolvedConnectAddress> {
    const requestedFamily = normalizeFamily(options.family);
    const literalFamily = isIPv4(hostname) ? 4 : isIPv6(hostname) ? 6 : 0;
    if (literalFamily) {
        if (requestedFamily && requestedFamily !== literalFamily) {
            const error = new Error('Address family not supported') as Error & { code?: string };
            error.code = 'EAI_FAMILY';
            return Promise.reject(error);
        }
        return Promise.resolve({ address: hostname, family: literalFamily });
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error: unknown, address?: string, family?: number | string): void => {
            if (settled) return;
            settled = true;
            if (error) {
                reject(error);
                return;
            }
            const resolvedFamily = family === 'IPv4' ? 4 : family === 'IPv6' ? 6 : family;
            if (typeof address !== 'string' || (resolvedFamily !== 4 && resolvedFamily !== 6)) {
                reject(Object.assign(new Error('Invalid address returned by lookup'), { code: 'EAI_FAIL' }));
                return;
            }
            if (requestedFamily && requestedFamily !== resolvedFamily) {
                reject(Object.assign(new Error('Address family not supported'), { code: 'EAI_FAMILY' }));
                return;
            }
            resolve({ address, family: resolvedFamily });
        };

        if (options.lookup) {
            try {
                options.lookup(hostname, {
                    family: requestedFamily,
                    hints: options.hints ?? 0,
                }, finish);
            } catch (error) {
                finish(error);
            }
            return;
        }

        nativeDns.resolve(hostname, {
            family: requestedFamily === 4 ? os.AF_INET : requestedFamily === 6 ? os.AF_INET6 : os.AF_UNSPEC,
        }).then((addresses: Array<{ ip: string; family: number }>) => {
            const first = addresses[0];
            finish(first ? null : Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), first?.ip, first?.family);
        }, finish);
    });
}

// ---------------------------------------------------------------------------
// IP-literal utilities.
//
// `isIP` / `isIPv4` / `isIPv6` plus the IPv6 parser they share with BlockList.
// No sibling imports, no native modules, no side effects.
// ---------------------------------------------------------------------------

export function isIP(input: string): number {
    if (isIPv4(input)) return 4;
    if (isIPv6(input)) return 6;
    return 0;
}

export function isIPv4(input: string): boolean {
    if (typeof input !== 'string') return false;
    const parts = input.split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => {
        if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return false;
        const num = Number(part);
        return num <= 255;
    });
}

// Module-private in the pre-split mod.ts. Exported here only so blocklist.ts
// can reuse the one parser; it is deliberately NOT re-exported from mod.ts, so
// the public `node:net` surface is unchanged.
export function parseIpv6Parts(input: string): number[] | null {
    if (typeof input !== 'string') return null;
    const zoneIndex = input.indexOf('%');
    const address = zoneIndex === -1 ? input : input.slice(0, zoneIndex);
    if (zoneIndex !== -1 && (zoneIndex === input.length - 1 || input.indexOf('%', zoneIndex + 1) !== -1)) return null;
    if (!address.includes(':')) return null;

    const compression = address.indexOf('::');
    if (compression !== -1 && address.indexOf('::', compression + 2) !== -1) return null;
    const leftText = compression === -1 ? address : address.slice(0, compression);
    const rightText = compression === -1 ? '' : address.slice(compression + 2);
    const left = leftText ? leftText.split(':') : [];
    const right = rightText ? rightText.split(':') : [];
    if (left.some(part => part === '') || right.some(part => part === '')) return null;

    const parseSide = (parts: string[], isRight: boolean): number[] | null => {
        const values: number[] = [];
        for (let index = 0; index < parts.length; index++) {
            const part = parts[index];
            if (part.includes('.')) {
                const isLastPart = index === parts.length - 1 && (isRight || right.length === 0);
                if (!isLastPart || !isIPv4(part)) return null;
                const bytes = part.split('.').map(Number);
                values.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
                continue;
            }
            if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
            values.push(Number.parseInt(part, 16));
        }
        return values;
    };

    const leftValues = parseSide(left, false);
    const rightValues = parseSide(right, true);
    if (!leftValues || !rightValues) return null;
    const supplied = leftValues.length + rightValues.length;
    if (compression === -1) return supplied === 8 ? leftValues : null;
    if (supplied >= 8) return null;
    return [...leftValues, ...Array(8 - supplied).fill(0), ...rightValues];
}

export function isIPv6(input: string): boolean {
    return parseIpv6Parts(input) !== null;
}
