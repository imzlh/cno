import { TcpSocket, type SocketTransport } from '@cnojs/http/socket';
import { dnsCache } from '@cnojs/http/dns-cache';
import { connectDirectTcp, createClientTlsContext, openTcp, type TlsOptions } from './http';
import type { RawConnection, RawConnectionHook } from './network-hooks';

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export type ProxyType = 'http' | 'https' | 'socks4' | 'socks4a' | 'socks5' | 'socks5h';

export interface ProxyConfig {
    url: string;
    type: ProxyType;
    user?: string | null;
    pass?: string | null;
    noProxy?: string | null;
}

function targetPort(url: URL): number {
    if (url.port) return parseInt(url.port);
    return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
}

function normalizeHost(hostname: string): string {
    return hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function splitHostPort(rule: string): { host: string; port: number | null } {
    const value = rule.trim();
    if (value.startsWith('[')) {
        const end = value.indexOf(']');
        const port = end >= 0 && value[end + 1] === ':' ? Number(value.slice(end + 2)) : null;
        return { host: normalizeHost(end >= 0 ? value.slice(0, end + 1) : value), port: Number.isFinite(port) ? port : null };
    }
    const colon = value.lastIndexOf(':');
    if (colon > 0 && value.indexOf(':') === colon && /^\d+$/.test(value.slice(colon + 1))) {
        return { host: normalizeHost(value.slice(0, colon)), port: Number(value.slice(colon + 1)) };
    }
    return { host: normalizeHost(value), port: null };
}

export function shouldBypassProxy(url: URL, noProxy?: string | null): boolean {
    if (!noProxy) return false;
    const hostname = normalizeHost(url.hostname);
    const port = targetPort(url);
    for (const raw of noProxy.split(/[;,]/)) {
        const value = raw.trim().toLowerCase();
        if (!value) continue;
        if (value === '*') return true;
        if (value === '<local>' && !hostname.includes('.')) return true;
        const { host, port: rulePort } = splitHostPort(value);
        if (!host || (rulePort !== null && rulePort !== port)) continue;
        const bare = host.startsWith('*.') ? host.slice(2) : host.startsWith('.') ? host.slice(1) : host;
        if (hostname === bare || hostname.endsWith(`.${bare}`)) return true;
    }
    return false;
}

async function readExact(socket: TcpSocket, size: number): Promise<Uint8Array> {
    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
        const chunk = await socket.read(size - offset);
        if (!chunk) throw new Error('Proxy closed during handshake');
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

/** An HTTP head plus any bytes read past its terminator. */
interface HttpHead {
    text: string;
    /** Bytes after `\r\n\r\n`. Belong to the tunnelled stream, never to the head. */
    leftover: Uint8Array | null;
}

/**
 * Read an HTTP head, stopping exactly at `\r\n\r\n`.
 *
 * Reads are 4096 bytes at a time, so the last one routinely returns bytes past the
 * terminator. For a CONNECT tunnel those bytes are the tunnelled stream's first
 * bytes, and returning them as part of the "head" silently destroyed them: whatever
 * the proxy pipelined behind `200 Connection Established` — a tunnelled response
 * body, or bytes injected by a tampering proxy — was consumed here and never
 * reached the tunnel. They are handed back as `leftover` so the caller can put them
 * back in front of the stream.
 *
 * @internal Exported for tests.
 */
export async function readHttpHead(socket: TcpSocket): Promise<HttpHead> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let matched = 0;
    /** Index one past the terminator, in the concatenation of `chunks`. */
    let headEnd = -1;
    const marker = [13, 10, 13, 10];
    while (length < 64 * 1024) {
        const chunk = await socket.read(4096);
        if (!chunk) throw new Error('HTTP proxy closed during CONNECT');
        chunks.push(chunk);
        for (let index = 0; index < chunk.length; index++) {
            const byte = chunk[index]!;
            matched = byte === marker[matched] ? matched + 1 : byte === marker[0] ? 1 : 0;
            if (matched === marker.length) { headEnd = length + index + 1; break; }
        }
        length += chunk.length;
        if (headEnd >= 0) break;
    }
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    if (headEnd < 0) throw new Error('HTTP proxy response headers are too large');
    return {
        text: engine.decodeString(joined.slice(0, headEnd)),
        leftover: headEnd < length ? joined.slice(headEnd) : null,
    };
}

function asBytes(buffer: CModuleStreams.BufferSource): Uint8Array {
    return buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer as ArrayBuffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * A transport that serves `prefix` before anything from `inner`.
 *
 * Every read path in TcpSocket — `read`, `readRaw`, both handshake loops, the
 * `onread` callback path — funnels through its `SocketTransport`, so replacing the
 * transport is the one interception point that covers all of them. That is why
 * pushback happens here rather than in each caller: the over-read becomes invisible
 * to every consumer of the returned socket, including the TLS handshake that runs
 * next, and no consumer needs to know a tunnel was involved.
 */
class PrependTransport implements SocketTransport {
    private prefix: Uint8Array | null;

    constructor(private readonly inner: SocketTransport, prefix: Uint8Array) {
        this.prefix = prefix.length > 0 ? prefix : null;
    }

    get onread(): SocketTransport['onread'] { return this.inner.onread; }
    set onread(value: SocketTransport['onread']) { this.inner.onread = value; }

    /** Hand back up to `max` prefix bytes, retaining the rest. */
    private take(max: number): Uint8Array | null {
        const prefix = this.prefix;
        if (!prefix || max <= 0) return null;
        if (prefix.length <= max) { this.prefix = null; return prefix; }
        this.prefix = prefix.subarray(max);
        return prefix.subarray(0, max);
    }

    async read(buffer: CModuleStreams.BufferSource): Promise<number> {
        const view = asBytes(buffer);
        const chunk = this.take(view.byteLength);
        if (!chunk) return this.inner.read(buffer);
        view.set(chunk);
        return chunk.byteLength;
    }

    write(buffer: CModuleStreams.BufferSource): Promise<number> { return this.inner.write(buffer); }

    startRead(): void {
        // Deliver the prefix before arming the inner reader, or the tunnel's first
        // bytes would arrive after bytes that followed them on the wire.
        const chunk = this.take(Number.MAX_SAFE_INTEGER);
        if (chunk) this.inner.onread?.(chunk, undefined);
        this.inner.startRead();
    }

    stopRead(): void { this.inner.stopRead(); }
    close(): void { this.inner.close(); }
}

/**
 * Wrap `transport` so `leftover` is served before anything from it.
 *
 * @internal Exported for tests.
 */
export function prependTunnelTransport(transport: SocketTransport, leftover: Uint8Array | null): SocketTransport {
    if (!leftover || leftover.length === 0) return transport;
    return new PrependTransport(transport, leftover);
}

/**
 * Put `leftover` back in front of `socket`'s stream.
 *
 * @internal Exported for tests.
 */
export function prependTunnelBytes(socket: TcpSocket, leftover: Uint8Array | null): TcpSocket {
    if (!leftover || leftover.length === 0) return socket;
    socket.socket = prependTunnelTransport(socket.socket, leftover);
    return socket;
}

function proxyPort(config: ProxyConfig, proxy: URL): number {
    if (proxy.port) return parseInt(proxy.port);
    return config.type.startsWith('socks') ? 1080 : config.type === 'https' ? 443 : 80;
}

function authority(hostname: string, port: number): string {
    const host = normalizeHost(hostname).includes(':') ? `[${normalizeHost(hostname)}]` : normalizeHost(hostname);
    return `${host}:${port}`;
}

/** Perform the CONNECT exchange. Returns bytes the proxy pipelined behind the 2xx. */
async function httpConnect(socket: TcpSocket, url: URL, config: ProxyConfig): Promise<Uint8Array | null> {
    const target = authority(url.hostname, targetPort(url));
    let request = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n`;
    const authorization = proxyAuthorization(config);
    if (authorization) request += `Proxy-Authorization: ${authorization}\r\n`;
    await socket.write(engine.encodeString(`${request}\r\n`));
    const { text: response, leftover } = await readHttpHead(socket);
    const statusLine = response.slice(0, response.indexOf('\r\n'));
    if (!/^HTTP\/\d\.\d 2\d\d(?:\s|$)/.test(statusLine)) {
        throw new Error(`HTTP proxy CONNECT failed: ${statusLine}`);
    }
    return leftover;
}

function proxyAuthorization(config: ProxyConfig): string | undefined {
    if (!config.user) return undefined;
    return `Basic ${crypto.base64Encode(engine.encodeString(`${config.user}:${config.pass ?? ''}`))}`;
}

function absoluteRequestTarget(url: URL): string {
    const target = new URL(url.href);
    if (target.protocol === 'ws:') target.protocol = 'http:';
    else if (target.protocol === 'wss:') target.protocol = 'https:';
    return target.href;
}

function ipv4Bytes(address: string): Uint8Array | null {
    const parts = address.split('.');
    if (parts.length !== 4) return null;
    const values = parts.map(Number);
    if (values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
    return new Uint8Array(values);
}

function ipv6Bytes(address: string): Uint8Array | null {
    let input = normalizeHost(address);
    const ipv4 = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (ipv4) {
        const bytes = ipv4Bytes(ipv4);
        if (!bytes) return null;
        input = `${input.slice(0, input.length - ipv4.length)}${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
    }
    const halves = input.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
    const words = [...left, ...Array(missing).fill('0'), ...right];
    if (words.length !== 8 || words.some(word => !/^[\da-f]{1,4}$/i.test(word))) return null;
    const output = new Uint8Array(16);
    words.forEach((word, index) => { const value = parseInt(word, 16); output[index * 2] = value >> 8; output[index * 2 + 1] = value & 255; });
    return output;
}

async function socks5Address(url: URL, remoteDns: boolean): Promise<Uint8Array> {
    const hostname = normalizeHost(url.hostname);
    let address = ipv4Bytes(hostname);
    if (address) return new Uint8Array([1, ...address]);
    const v6 = ipv6Bytes(hostname);
    if (v6) return new Uint8Array([4, ...v6]);
    if (!remoteDns) {
        const resolved = await dnsCache.resolve(hostname);
        const preferred = resolved.find(item => item.family === 4) ?? resolved[0];
        if (!preferred) throw new Error(`DNS resolution failed for ${hostname}`);
        address = ipv4Bytes(preferred.ip);
        if (address) return new Uint8Array([1, ...address]);
        const resolvedV6 = ipv6Bytes(preferred.ip);
        if (resolvedV6) return new Uint8Array([4, ...resolvedV6]);
        throw new Error(`Unsupported resolved address: ${preferred.ip}`);
    }
    const encoded = engine.encodeString(hostname);
    if (encoded.length > 255) throw new Error('SOCKS5 target hostname is too long');
    return new Uint8Array([3, encoded.length, ...encoded]);
}

async function socks5Connect(socket: TcpSocket, url: URL, config: ProxyConfig): Promise<void> {
    const hasCredentials = config.user !== null && config.user !== undefined;
    await socket.write(new Uint8Array(hasCredentials ? [5, 2, 0, 2] : [5, 1, 0]));
    const method = await readExact(socket, 2);
    if (method[0] !== 5 || (method[1] !== 0 && method[1] !== 2)) throw new Error(`SOCKS5 unsupported authentication method: ${method[1]}`);
    if (method[1] === 2) {
        if (!hasCredentials) throw new Error('SOCKS5 proxy requires authentication');
        const user = engine.encodeString(config.user ?? '');
        const pass = engine.encodeString(config.pass ?? '');
        if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 credentials are too long');
        await socket.write(new Uint8Array([1, user.length, ...user, pass.length, ...pass]));
        const response = await readExact(socket, 2);
        if (response[0] !== 1 || response[1] !== 0) throw new Error('SOCKS5 authentication failed');
    }
    const address = await socks5Address(url, config.type === 'socks5h');
    const port = targetPort(url);
    await socket.write(new Uint8Array([5, 1, 0, ...address, port >> 8, port & 255]));
    const head = await readExact(socket, 4);
    if (head[0] !== 5 || head[2] !== 0) throw new Error('Invalid SOCKS5 CONNECT response');
    if (head[1] !== 0) throw new Error(`SOCKS5 CONNECT failed: ${head[1]}`);
    const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? (await readExact(socket, 1))[0]! : -1;
    if (addressLength < 0) throw new Error(`Invalid SOCKS5 address type: ${head[3]}`);
    await readExact(socket, addressLength + 2);
}

async function socks4Connect(socket: TcpSocket, url: URL, config: ProxyConfig): Promise<void> {
    const hostname = normalizeHost(url.hostname);
    const remoteDns = config.type === 'socks4a';
    let address = remoteDns ? new Uint8Array([0, 0, 0, 1]) : ipv4Bytes(hostname);
    if (!address) {
        const resolved = (await dnsCache.resolve(hostname)).find(item => item.family === 4);
        address = resolved ? ipv4Bytes(resolved.ip) : null;
    }
    if (!address) throw new Error('SOCKS4 target did not resolve to IPv4');
    const user = engine.encodeString(config.user ?? '');
    const host = remoteDns ? engine.encodeString(hostname) : new Uint8Array(0);
    if (user.includes(0) || host.includes(0)) throw new Error('SOCKS4 fields must not contain NUL');
    const port = targetPort(url);
    await socket.write(new Uint8Array([4, 1, port >> 8, port & 255, ...address, ...user, 0, ...host, ...(remoteDns ? [0] : [])]));
    const response = await readExact(socket, 8);
    if (response[0] !== 0 || response[1] !== 90) throw new Error(`SOCKS4 CONNECT failed: ${response[1]}`);
}

class SocketStreamAdapter implements SocketTransport {
    onread: CModuleStreams.Stream['onread'] = (() => {}) as CModuleStreams.Stream['onread'];
    constructor(private readonly socket: TcpSocket) {}
    async read(buffer: ArrayBuffer | ArrayBufferView): Promise<number> {
        const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const data = await this.socket.read(view.byteLength);
        if (!data) return 0;
        view.set(data); return data.byteLength;
    }
    async write(buffer: ArrayBuffer | ArrayBufferView): Promise<number> {
        const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        await this.socket.write(new Uint8Array(view)); return view.byteLength;
    }
    startRead(): void {
        this.socket.onReadable(
            data => data === null ? this.onread(null, undefined) : this.onread(data, undefined),
            error => this.onread(undefined, error as CModuleError.Error),
        );
    }
    stopRead(): void { this.socket.stopReading(); }
    close(): void { this.socket.close(); }
}

/**
 * Wrap `socket` in TLS as a client, verifying the peer by default.
 *
 * Used for two distinct trust decisions: the connection to an `https` proxy
 * (verified against the *proxy's* hostname) and the tunnelled connection to the
 * target (verified against the *target's* hostname). Both go through the same
 * shared context builder so neither can silently end up unverified.
 */
async function startTls(socket: TcpSocket, hostname: string, tls?: TlsOptions): Promise<TcpSocket> {
    await socket.clientHandshake(createClientTlsContext(['http/1.1'], tls, hostname), hostname);
    return socket;
}

async function startNestedTls(socket: TcpSocket, hostname: string, leftover: Uint8Array | null, tls?: TlsOptions): Promise<TcpSocket> {
    // The leftover was read through the *outer* TLS session, so it is plaintext to
    // the proxy and ciphertext to the tunnel. It therefore belongs in front of the
    // nested socket's transport (the adapter), not the outer socket's transport,
    // which carries proxy-side cipher.
    const nested = new TcpSocket(prependTunnelTransport(new SocketStreamAdapter(socket), leftover));
    return startTls(nested, hostname, tls);
}

export async function connectViaProxy(url: URL, config: ProxyConfig, tls?: TlsOptions): Promise<RawConnection> {
    if (shouldBypassProxy(url, config.noProxy)) return { socket: await connectDirectTcp(url, tls) };
    const proxy = new URL(config.url);
    let socket = await openTcp(normalizeHost(proxy.hostname), proxyPort(config, proxy));
    try {
        if (config.type === 'https') socket = await startTls(socket, normalizeHost(proxy.hostname), tls);
        const secureTarget = url.protocol === 'https:' || url.protocol === 'wss:';
        if ((config.type === 'http' || config.type === 'https') && !secureTarget) {
            return {
                socket,
                requestTarget: absoluteRequestTarget(url),
                proxyAuthorization: proxyAuthorization(config),
            };
        }
        let leftover: Uint8Array | null = null;
        if (config.type === 'http' || config.type === 'https') leftover = await httpConnect(socket, url, config);
        else if (config.type === 'socks5' || config.type === 'socks5h') await socks5Connect(socket, url, config);
        else await socks4Connect(socket, url, config);
        if (secureTarget) {
            const hostname = normalizeHost(url.hostname);
            socket = config.type === 'https'
                ? await startNestedTls(socket, hostname, leftover, tls)
                : await startTls(prependTunnelBytes(socket, leftover), hostname, tls);
        } else {
            socket = prependTunnelBytes(socket, leftover);
        }
        return { socket };
    } catch (err) {
        socket.close();
        throw err;
    }
}

export function createProxyConnector(getConfig: (url: URL) => ProxyConfig | null, tls?: TlsOptions): RawConnectionHook {
    return url => {
        const config = getConfig(url);
        return config ? connectViaProxy(url, config, tls) : connectDirectTcp(url, tls).then(socket => ({ socket }));
    };
}
