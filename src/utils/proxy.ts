import { TcpSocket, type SocketTransport } from '@cnojs/http/socket';
import { dnsCache } from '@cnojs/http/dns-cache';
import { connectDirectTcp, openTcp } from './http';
import type { RawConnection, RawConnectionHook } from './network-hooks';

const engine = import.meta.use('engine');
const crypto = import.meta.use('crypto');
const ssl = import.meta.use('ssl');

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

async function readHttpHead(socket: TcpSocket): Promise<string> {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let matched = 0;
    const marker = [13, 10, 13, 10];
    while (length < 64 * 1024) {
        const chunk = await socket.read(4096);
        if (!chunk) throw new Error('HTTP proxy closed during CONNECT');
        chunks.push(chunk); length += chunk.length;
        for (const byte of chunk) {
            matched = byte === marker[matched] ? matched + 1 : byte === marker[0] ? 1 : 0;
            if (matched === marker.length) break;
        }
        if (matched === marker.length) break;
    }
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    const text = engine.decodeString(joined);
    if (!text.includes('\r\n\r\n')) throw new Error('HTTP proxy response headers are too large');
    return text;
}

function proxyPort(config: ProxyConfig, proxy: URL): number {
    if (proxy.port) return parseInt(proxy.port);
    return config.type.startsWith('socks') ? 1080 : config.type === 'https' ? 443 : 80;
}

function authority(hostname: string, port: number): string {
    const host = normalizeHost(hostname).includes(':') ? `[${normalizeHost(hostname)}]` : normalizeHost(hostname);
    return `${host}:${port}`;
}

async function httpConnect(socket: TcpSocket, url: URL, config: ProxyConfig): Promise<void> {
    const target = authority(url.hostname, targetPort(url));
    let request = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n`;
    const authorization = proxyAuthorization(config);
    if (authorization) request += `Proxy-Authorization: ${authorization}\r\n`;
    await socket.write(engine.encodeString(`${request}\r\n`));
    const response = await readHttpHead(socket);
    const statusLine = response.slice(0, response.indexOf('\r\n'));
    if (!/^HTTP\/\d\.\d 2\d\d(?:\s|$)/.test(statusLine)) {
        throw new Error(`HTTP proxy CONNECT failed: ${statusLine}`);
    }
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

async function startTls(socket: TcpSocket, hostname: string): Promise<TcpSocket> {
    const context = new ssl.Context({ alpn: ['http/1.1'], mode: 'client' });
    await socket.clientHandshake(context, hostname);
    return socket;
}

async function startNestedTls(socket: TcpSocket, hostname: string): Promise<TcpSocket> {
    const nested = new TcpSocket(new SocketStreamAdapter(socket));
    return startTls(nested, hostname);
}

export async function connectViaProxy(url: URL, config: ProxyConfig): Promise<RawConnection> {
    if (shouldBypassProxy(url, config.noProxy)) return { socket: await connectDirectTcp(url) };
    const proxy = new URL(config.url);
    let socket = await openTcp(normalizeHost(proxy.hostname), proxyPort(config, proxy));
    if (config.type === 'https') socket = await startTls(socket, normalizeHost(proxy.hostname));
    const secureTarget = url.protocol === 'https:' || url.protocol === 'wss:';
    if ((config.type === 'http' || config.type === 'https') && !secureTarget) {
        return {
            socket,
            requestTarget: absoluteRequestTarget(url),
            proxyAuthorization: proxyAuthorization(config),
        };
    }
    if (config.type === 'http' || config.type === 'https') await httpConnect(socket, url, config);
    else if (config.type === 'socks5' || config.type === 'socks5h') await socks5Connect(socket, url, config);
    else await socks4Connect(socket, url, config);
    if (secureTarget) {
        const hostname = normalizeHost(url.hostname);
        socket = config.type === 'https' ? await startNestedTls(socket, hostname) : await startTls(socket, hostname);
    }
    return { socket };
}

export function createProxyConnector(getConfig: (url: URL) => ProxyConfig | null): RawConnectionHook {
    return url => {
        const config = getConfig(url);
        return config ? connectViaProxy(url, config) : connectDirectTcp(url).then(socket => ({ socket }));
    };
}
