import { malloc } from "../utils/malloc";
import { wrapFsClassDec as wrap, wrapFSErr, wrapFSns } from "../utils/wrap";
import { DOMException } from "../webapi/events";

const os = import.meta.use('os');
const stream = import.meta.use('streams');
const ssl = import.meta.use('ssl');
const dns = import.meta.use('dns');
const windows = import.meta.use('win32');
const timers = import.meta.use('timers');

import { dnsCache } from '@cnojs/http/dns-cache';

const symbolTakePipe = Symbol('Stream.takePipe');

export const useWritable = (pipe: CModuleStreams.Stream) => new WritableStream({
    write: async (chunk, control) => {
        try {
            await pipe.write(chunk);
        } catch (e) {
            control.error(wrapFSErr(e as any));
        }
    },
    close: () => {
        pipe.close();
    }
});

export const useReadable = (pipe: CModuleStreams.Stream) => new ReadableStream({
    async pull(controller) {
        try {
            const buf = malloc(controller);
            const n = await pipe.read(buf);
            if (n === 0) {
                controller.close();
            } else {
                controller.enqueue(buf.slice(0, n));
            }
        } catch (e) {
            controller.error(wrapFSErr(e as any));
        }
    }
});

const kRawPipe = Symbol('Stream.rawPipe');

class Conn<T extends Deno.Addr = Deno.Addr> implements Deno.Conn<T> {
    protected $readable: ReadableStream;
    protected $writable: WritableStream;
    protected $consumed = false;
    [kRawPipe]: CModuleStreams.Stream;

    constructor(
        protected readonly pipe: CModuleStreams.Stream,
        public readonly localAddr: T,
        public readonly remoteAddr: T
    ) {
        this.$readable = useReadable(pipe);
        this.$writable = useWritable(pipe);
        this[kRawPipe] = pipe;
    }

    protected assertUsable(): void {
        if (this.$consumed) throw new Deno.errors.BadResource('Connection has been consumed');
    }

    @wrap
    read(p: Uint8Array): Promise<number | null> {
        this.assertUsable();
        return this.pipe.read(p).then(n => n === 0 ? null : n);
    }

    @wrap
    write(p: Uint8Array): Promise<number> {
        this.assertUsable();
        return this.pipe.write(p);
    }

    @wrap
    close(): void {
        if (this.$consumed) return;
        this.pipe.close();
    }

    @wrap
    async closeWrite(): Promise<void> {
        this.assertUsable();
        return this.pipe.shutdown();
    }

    ref(): void {
        this.assertUsable();
        this.pipe.ref();
    }

    unref(): void {
        this.assertUsable();
        this.pipe.unref();
    }

    get readable(): ReadableStream {
        this.assertUsable();
        return this.$readable;
    }

    get writable(): WritableStream {
        this.assertUsable();
        return this.$writable;
    }

    @wrap
    [Symbol.dispose]() {
        return this.pipe.close();
    }

    [symbolTakePipe]() {
        this.assertUsable();
        this.$consumed = true;
        return this.pipe;
    }
}

const addrinfo2deno = (info: CModuleStreams.AddressInfo): Deno.NetAddr => ({
    transport: 'tcp',
    hostname: info.ip,
    port: info.port
});

class TcpConn extends Conn<Deno.NetAddr> implements Deno.TcpConn {
    constructor(
        pipe: CModuleStreams.TCP
    ) {
        super(pipe, addrinfo2deno(pipe.sockname), addrinfo2deno(pipe.peername));
    }

    @wrap
    setNoDelay(noDelay?: boolean): void {
        (this.pipe as CModuleStreams.TCP).setNoDelay(noDelay ?? false);
    }

    @wrap
    setKeepAlive(keepAlive?: boolean): void {
        // TODO: 60 seconds is hardcoded
        (this.pipe as CModuleStreams.TCP).setKeepAlive(!!keepAlive, 60);
    }
}

class TlsConn implements Deno.TlsConn {
    private static readonly READ_HIGH_WATER = 256 * 1024;
    private static readonly READ_LOW_WATER = 128 * 1024;

    private $readable: ReadableStream;
    private $writable: WritableStream;
    private $handshake: Promise<Deno.TlsHandshakeInfo>;
    private $handshakeResolve!: (info: Deno.TlsHandshakeInfo) => void;
    private $handshakeReject!: (err: unknown) => void;
    private $handshakeDone = false;
    private $readQueue: Uint8Array[] = [];
    private $readQueueSize = 0;
    private $readWaiters: PromiseWithResolvers<void>[] = [];
    private $tlsWaiters: PromiseWithResolvers<void>[] = [];
    private $readError: unknown;
    private $eof = false;
    private $reading = false;
    private $closing = false;
    private $closed = false;
    private $readChain: Promise<void> = Promise.resolve();
    readonly localAddr: Deno.NetAddr;
    readonly remoteAddr: Deno.NetAddr;

    constructor(
        protected $pipe: CModuleSSL.Pipe,
        protected $rawPipe: CModuleStreams.TCP
    ) {
        const self = this;
        this.$handshake = new Promise<Deno.TlsHandshakeInfo>((resolve, reject) => {
            this.$handshakeResolve = resolve;
            this.$handshakeReject = reject;
        });
        this.$readable = new ReadableStream({
            async pull(controller) {
                try {
                    const buf = malloc(controller);
                    const n = await self.read(buf);
                    if (n === null || n === 0) {
                        controller.close();
                    } else {
                        controller.enqueue(buf.slice(0, n));
                    }
                } catch (e) {
                    controller.error(wrapFSErr(e as any));
                }
            }
        });
        this.$writable = new WritableStream({
            write: async (chunk, control) => {
                try {
                    await this.$handshake;
                    let written = 0;
                    while (written < chunk.length) {
                        const n = $pipe.write(chunk.subarray(written));
                        if (n === null) {
                            await this.output();
                            await this.waitForTlsProgress();
                            continue;
                        }
                        written += n;
                        await this.output();
                    }
                } catch (e) {
                    control.error(wrapFSErr(e as any));
                }
            }
        });
        this.localAddr = addrinfo2deno(this.$rawPipe.sockname);
        this.remoteAddr = addrinfo2deno(this.$rawPipe.peername);
        this.startEncryptedRead();
    }

    @wrap
    private async output() {
        while (true) {
            const obuf = this.$pipe.getOutput();
            if (!obuf || obuf.byteLength === 0) return;
            await this.$rawPipe.write(new Uint8Array(obuf));
        }
    }

    private startEncryptedRead(): void {
        this.$rawPipe.onread = (data, err) => {
            this.$readChain = this.$readChain
                .then(() => this.onEncryptedRead(data, err))
                .catch(e => this.fail(e));
        };
        this.resumeEncryptedRead();
        this.driveTls().catch(e => this.fail(e));
    }

    private resumeEncryptedRead(force = false): void {
        if (this.$closed || this.$reading) return;
        if (!force && (this.$eof || this.$readQueueSize >= TlsConn.READ_HIGH_WATER)) return;
        this.$rawPipe.startRead();
        this.$reading = true;
    }

    private pauseEncryptedRead(): void {
        if (!this.$reading) return;
        this.$rawPipe.stopRead();
        this.$reading = false;
    }

    private async onEncryptedRead(data: Uint8Array | null | undefined, err: CModuleError.Error | undefined): Promise<void> {
        if (err || data === undefined) {
            this.fail(err ?? new Error('TLS read failed'));
            return;
        }
        if (data === null) {
            this.$eof = true;
            this.pauseEncryptedRead();
            if (!this.$handshakeDone) this.$handshakeReject(new Error('TLS failed to handshake: EOF'));
            this.wakeWaiters();
            if (this.$closing) this.finishClose();
            return;
        }
        this.$pipe.feed(data);
        await this.driveTls();
    }

    private async driveTls(): Promise<void> {
        if (!this.$handshakeDone && this.$pipe.handshake()) {
            this.$handshakeDone = true;
            this.$handshakeResolve({ alpnProtocol: this.$pipe.alpnProtocol });
        }
        await this.output();
        if (this.$handshakeDone && !this.$eof) {
            this.drainPlaintext();
        }
        this.wakeTlsWaiters();
    }

    private drainPlaintext(): void {
        while (true) {
            const data = this.$pipe.read(16384);
            if (data === null) break;
            const chunk = new Uint8Array(data);
            if (chunk.byteLength === 0) break;
            this.$readQueue.push(chunk);
            this.$readQueueSize += chunk.byteLength;
            if (this.$readQueueSize >= TlsConn.READ_HIGH_WATER) {
                this.pauseEncryptedRead();
                break;
            }
        }
        this.wakeReadWaiters();
    }

    private wakeReadWaiters(): void {
        const waiters = this.$readWaiters.splice(0);
        for (const waiter of waiters) waiter.resolve();
    }

    private wakeTlsWaiters(): void {
        const waiters = this.$tlsWaiters.splice(0);
        for (const waiter of waiters) waiter.resolve();
    }

    private wakeWaiters(): void {
        this.wakeReadWaiters();
        this.wakeTlsWaiters();
    }

    private waitForRead(): Promise<void> {
        if (this.$readError) return Promise.reject(this.$readError);
        if (this.$readQueueSize > 0 || this.$eof) return Promise.resolve();
        const waiter = Promise.withResolvers<void>();
        this.$readWaiters.push(waiter);
        return waiter.promise;
    }

    private waitForTlsProgress(): Promise<void> {
        if (this.$readError) return Promise.reject(this.$readError);
        if (this.$eof) return Promise.resolve();
        const waiter = Promise.withResolvers<void>();
        this.$tlsWaiters.push(waiter);
        return waiter.promise;
    }

    private fail(err: unknown): void {
        this.$readError = err;
        if (!this.$handshakeDone) this.$handshakeReject(err);
        this.pauseEncryptedRead();
        this.wakeWaiters();
        if (this.$closing) this.finishClose();
    }

    private finishClose(): void {
        if (this.$closed) return;
        this.$closed = true;
        this.pauseEncryptedRead();
        // @ts-ignore
        this.$rawPipe.onread = null;
        try {
            this.$rawPipe.close();
        } catch {
            // Ignore close errors from an already-closed socket.
        }
    }

    get readable(): ReadableStream {
        return this.$readable;
    }

    get writable(): WritableStream {
        return this.$writable;
    }

    @wrap
    async close(): Promise<void> {
        if (this.$closed || this.$closing) return;
        this.$closing = true;
        this.$eof = true;
        this.wakeWaiters();
        try {
            this.$pipe.shutdown();
            await this.output();
        } catch {
            // Ignore TLS shutdown errors during close.
        }
        try {
            await this.$rawPipe.shutdown();
        } catch {
            // Ignore shutdown errors during close.
            this.finishClose();
            return;
        }
        this.resumeEncryptedRead(true);
    }

    handshake(): Promise<Deno.TlsHandshakeInfo> {
        return this.$handshake;
    }

    ref(): void {
        this.$rawPipe.ref();
    }

    unref(): void {
        this.$rawPipe.unref();
    }

    @wrap
    async read(p: Uint8Array): Promise<number | null> {
        if (p.byteLength === 0) return 0;
        await this.$handshake;
        while (this.$readQueueSize === 0) {
            if (this.$readError) throw this.$readError;
            if (this.$eof) return null;
            await this.waitForRead();
        }

        let copied = 0;
        while (copied < p.byteLength && this.$readQueue.length > 0) {
            const chunk = this.$readQueue[0]!;
            const n = Math.min(chunk.byteLength, p.byteLength - copied);
            p.set(chunk.subarray(0, n), copied);
            copied += n;
            this.$readQueueSize -= n;
            if (n === chunk.byteLength) {
                this.$readQueue.shift();
            } else {
                this.$readQueue[0] = chunk.subarray(n);
            }
        }

        if (this.$readQueueSize < TlsConn.READ_LOW_WATER) this.resumeEncryptedRead();
        return copied;
    }

    @wrap
    async write(p: Uint8Array): Promise<number> {
        await this.$handshake;
        let written = 0;
        while (written < p.byteLength) {
            const n = this.$pipe.write(p.subarray(written));
            if (n === null) {
                await this.output();
                await this.waitForTlsProgress();
                continue;
            }
            written += n;
            await this.output();
        }
        return written;
    }

    @wrap
    async closeWrite(): Promise<void> {
        this.$pipe.shutdown();
        await this.output();
        await this.$rawPipe.shutdown();
    }

    @wrap
    [Symbol.dispose]() {
        this.close();
    }
}

class UnixConn extends Conn<Deno.UnixAddr> implements Deno.UnixConn {
    constructor(
        pipe: CModuleStreams.Pipe,
        path: string
    ) {
        super(pipe, { path, transport: 'unix' }, { path, transport: 'unix' });
    }
}

class Listener implements Deno.Listener {
    private $acceptQueue: CModuleStreams.Stream[] = [];
    private $acceptPromise?: PromiseWithResolvers<CModuleStreams.Stream>;
    constructor(
        protected $pipe: CModuleStreams.Stream,
        protected $isTCP: boolean,
        protected $addr: Deno.Addr
    ) {
        $pipe.onconnection = (err, client) => {
            if (err || !client) {
                if (this.$acceptPromise) {
                    this.$acceptPromise.reject(err ?? (new Error('Accept error')));
                    this.$acceptPromise = undefined;
                }
                return;
            }
            if (this.$acceptPromise) {
                this.$acceptPromise.resolve(client);
                this.$acceptPromise = undefined;
                return;
            }
            this.$acceptQueue.push(client);
        };
    }

    @wrap
    async accept(): Promise<Deno.Conn<Deno.Addr>> {
        let conn = this.$acceptQueue.shift();
        if (!conn) {
            this.$acceptPromise = Promise.withResolvers();
            conn = await this.$acceptPromise.promise;
        }
        return this.$isTCP
            ? new TcpConn(conn as CModuleStreams.TCP)
            : new UnixConn(conn as CModuleStreams.Pipe, (this.$addr as Deno.UnixAddr).path);
    }

    close(): void {
        this.$pipe.close();
    }

    ref(): void {
        this.$pipe.ref();
    }

    unref(): void {
        this.$pipe.unref();
    }

    get addr(): Deno.Addr {
        return this.$addr;
    }

    @wrap
    async *[Symbol.asyncIterator]() {
        while (true) {
            const conn = await this.accept();
            yield conn;
        }
    }

    @wrap
    [Symbol.dispose]() {
        return this.close();
    }
}

function toConn(sslpipe: CModuleSSL.Pipe, pipe: CModuleStreams.TCP): Deno.TlsConn {
    return new TlsConn(sslpipe, pipe);
}

function normalizeHostname(hostname: string): string {
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isIPv6Hostname(hostname: string): boolean {
    return normalizeHostname(hostname).includes(':');
}

function abortReason(signal?: AbortSignal): unknown {
    return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function timeoutReason(): DOMException {
    return new DOMException('The operation timed out', 'TimeoutError');
}

function decodeTxtRecord(txt: string): string[] {
    const chunks: string[] = [];
    let offset = 0;
    while (offset < txt.length) {
        const len = txt.charCodeAt(offset);
        if (len > txt.length - offset - 1) return [txt];
        chunks.push(txt.slice(offset + 1, offset + 1 + len));
        offset += len + 1;
    }
    return chunks;
}

async function withAbort<T>(op: Promise<T>, signal?: AbortSignal, cleanup?: () => void): Promise<T> {
    if (!signal) return op;
    if (signal.aborted) {
        try {
            cleanup?.();
        } catch {
            // Ignore cleanup errors so the abort reason is preserved.
        }
        throw abortReason(signal);
    }

    let aborted = false;
    let onAbort!: () => void;
    const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => {
            aborted = true;
            try {
                cleanup?.();
            } catch {
                // Ignore cleanup errors so the abort reason is preserved.
            } finally {
                reject(abortReason(signal));
            }
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
        const guardedOp = op.catch(err => {
            if (aborted) return new Promise<T>(() => { });
            throw err;
        });
        return await Promise.race([guardedOp, abortPromise]);
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

async function withTimeoutAbort<T>(
    op: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
    cleanup?: () => void,
): Promise<T> {
    const ac = new AbortController();
    const timeoutId = timers.setTimeout(() => ac.abort(timeoutReason()), timeoutMs);
    let onAbort: (() => void) | undefined;
    if (signal) {
        if (signal.aborted) {
            ac.abort(abortReason(signal));
        } else {
            onAbort = () => ac.abort(abortReason(signal));
            signal.addEventListener('abort', onAbort, { once: true });
        }
    }

    try {
        return await withAbort(op, ac.signal, cleanup);
    } finally {
        timers.clearTimeout(timeoutId);
        if (onAbort) signal!.removeEventListener('abort', onAbort);
    }
}

let systemCaPemCache: string | null | undefined;
let systemDnsServerCache: string | null | undefined;

function firstIPv4DnsServer(value: unknown): string | undefined {
    const servers = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/) : [];
    return servers.find(server => typeof server === 'string' && server && !server.includes(':'));
}

function systemDnsServer(): string | undefined {
    if (systemDnsServerCache !== undefined) return systemDnsServerCache ?? undefined;
    systemDnsServerCache = null;
    if (os.uname().sysname === 'Windows_NT' && windows) {
        for (const name of ['NameServer', 'DhcpNameServer']) {
            try {
                const server = firstIPv4DnsServer(windows.readRegistry(
                    windows.HKLM,
                    'SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters',
                    name,
                ));
                if (server) {
                    systemDnsServerCache = server;
                    break;
                }
            } catch {
                // Keep falling back through the available registry values.
            }
        }
    }
    return systemDnsServerCache ?? undefined;
}

function systemCaPem(): string | undefined {
    if (systemCaPemCache !== undefined) return systemCaPemCache ?? undefined;
    systemCaPemCache = null;
    if (os.uname().sysname === 'Windows_NT') {
        try {
            const certs = windows?.exportCerts();
            if (certs?.length) systemCaPemCache = certs.join('\n');
        } catch {
            systemCaPemCache = null;
        }
    }
    return systemCaPemCache ?? undefined;
}

function caCertsPem(caCerts?: string[]): string | undefined {
    const certs = caCerts?.filter(cert => cert && cert.trim()) ?? [];
    const system = systemCaPem();
    if (system) certs.unshift(system);
    return certs.length ? certs.join('\n') : undefined;
}

async function connectTcp(hostname: string, port: number, signal?: AbortSignal): Promise<CModuleStreams.TCP> {
    const host = normalizeHostname(hostname);
    const family = isIPv6Hostname(host) ? 6 : 4;
    const tcp = new stream.TCP(family === 6 ? os.AF_INET6 : os.AF_INET);
    const dnsanswer = await withAbort(dnsCache.resolve(host, { family }), signal, () => tcp.close());
    const ip = dnsanswer[0]?.ip;
    if (!ip) {
        tcp.close();
        throw new Error(`Could not resolve hostname ${host}`);
    }
    await withAbort(tcp.connect({ ip, port }), signal, () => tcp.close());
    return tcp;
}

class TcpListener extends Listener implements Deno.TcpListener {
    get addr(): Deno.NetAddr {
        return this.$addr as Deno.NetAddr;
    }

    @wrap
    accept(): Promise<Deno.TcpConn> {
        return super.accept() as Promise<Deno.TcpConn>;
    }

    @wrap
    async*[Symbol.asyncIterator]() {
        while (true) {
            const conn = await this.accept();
            yield conn;
        }
    }
}

class TlsListener extends Listener implements Deno.TlsListener {
    constructor(pipe: CModuleStreams.Stream, addr: Deno.NetAddr, protected sslCtx: CModuleSSL.Context) {
        super(pipe, true, addr);
    }

    @wrap
    async accept(): Promise<Deno.TlsConn> {
        const conn = await super.accept();

        // create SSLPipe
        const sslpipe = new ssl.Pipe(this.sslCtx, {
            servername: (this.$addr as Deno.NetAddr).hostname
        });
        // @ts-ignore - Conn
        return toConn(sslpipe, conn[kRawPipe]);
    }

    @wrap
    async*[Symbol.asyncIterator]() {
        while (true) {
            const conn = await this.accept();
            yield conn;
        }
    }

    get addr(): Deno.NetAddr {
        return this.$addr as Deno.NetAddr;
    }
}

Object.assign(Deno, wrapFSns({
    networkInterfaces() {
        const intf = os.networkInterfaces();
        return intf.map(i => ({
            ...i,
            family: i.address.includes(':') ? 'IPv6' : 'IPv4',
            scopeid: i.scopeId ?? null,
            cidr: i.netmask
        }));
    },
    // @ts-ignore overload implementation is selected by record type at runtime.
    async resolveDns(query, type = 'A', opt) {
        let server: undefined | string;
        let port: undefined | number;
        if (opt?.nameServer) {
            server = opt.nameServer.ipAddr;
            port = opt.nameServer.port;
            if (port !== undefined && (port <= 0 || port > 65535))
                throw new RangeError('Invalid DNS nameServer port');
        } else {
            server = systemDnsServer();
        }

        const typeMap: Record<string, number> = {
            A: dns.A,
            AAAA: dns.AAAA,
            ANAME: dns.CNAME,
            CAA: dns.CAA,
            CNAME: dns.CNAME,
            MX: dns.MX,
            NAPTR: dns.NAPTR,
            NS: dns.NS,
            PTR: dns.PTR,
            SOA: dns.SOA,
            SRV: dns.SRV,
            TXT: dns.TXT,
        };
        const nativeType = typeMap[type];
        if (!nativeType) throw new Error(`Unsupported DNS record type: ${type}`);

        const request = dns.query(query, nativeType, server, port);
        const info = await withTimeoutAbort(request, 5000, opt?.signal, () => request.abort?.());
        switch (type) {
            case 'A':
            case 'AAAA':
                // @ts-ignore
                return info.filter<CModuleDNS.AddressAnswer>(i => i.type == nativeType).map(i => i.address);
            case 'ANAME':
            case 'CNAME':
                // @ts-ignore
                return info.filter<CModuleDNS.CNameAnswer>(i => i.type == dns.CNAME).map(i => i.cname);
            case 'NS':
                // @ts-ignore
                return info.filter<CModuleDNS.NsAnswer>(i => i.type == dns.NS).map(i => i.ns);
            case 'PTR':
                // @ts-ignore
                return info.filter<CModuleDNS.PtrAnswer>(i => i.type == dns.PTR).map(i => i.ptr);
            case "CAA":
                // @ts-ignore
                return info.filter<CModuleDNS.CaaAnswer>(i => i.type == dns.CAA).map(i => ({
                    critical: (i.flags & 0x80) !== 0,
                    tag: i.tag,
                    value: i.value
                } satisfies Deno.CaaRecord));
            case "MX":
                // @ts-ignore
                return info.filter<CModuleDNS.MxAnswer>(i => i.type == dns.MX).map(i => ({
                    exchange: i.exchange,
                    preference: i.priority
                } satisfies Deno.MxRecord));
            case "NAPTR":
                // @ts-ignore
                return info.filter<CModuleDNS.NaptrAnswer>(i => i.type == dns.NAPTR).map(i => ({
                    flags: i.flags,
                    order: i.order,
                    preference: i.preference,
                    regexp: i.regexp,
                    replacement: i.replacement,
                    services: i.services
                } satisfies Deno.NaptrRecord));
            case "SOA":
                // @ts-ignore
                return info.filter<CModuleDNS.SoaAnswer>(i => i.type == dns.SOA).map(i => ({
                    expire: i.expire,
                    refresh: i.refresh,
                    retry: i.retry,
                    serial: i.serial,
                    minimum: i.minimum,
                    mname: i.primary,
                    rname: i.admin
                } satisfies Deno.SoaRecord));
            case "SRV":
                // @ts-ignore
                return info.filter<CModuleDNS.SrvAnswer>(i => i.type == dns.SRV).map(i => ({
                    port: i.port,
                    priority: i.priority,
                    target: i.target,
                    weight: i.weight
                } satisfies Deno.SrvRecord));
            case "TXT":
                // @ts-ignore
                return info.filter<CModuleDNS.TxtAnswer>(i => i.type == dns.TXT).map(i => decodeTxtRecord(i.txt));
            default:
                throw new Error(`Unsupported DNS record type: ${type}`);
        }
    },

    // @ts-ignore
    async connect(options) {
        switch (options.transport) {
            case undefined:
            case 'tcp':
                return new TcpConn(await connectTcp(options.hostname ?? '127.0.0.1', options.port, options.signal));
            case 'unix':
                const unix = new stream.Pipe();
                await unix.connect(options.path);
                return new UnixConn(unix, options.path);
            default:
                throw new Deno.errors.NotSupported(`Unsupported transport: ${options.transport}`);
        }
    },

    async connectTls(options) {
        const tlsOptions = options as any;
        if (tlsOptions.keyFormat && tlsOptions.keyFormat !== 'pem')
            throw new TypeError(`Unsupported key format: ${tlsOptions.keyFormat}`);
        const hostname = options.hostname ?? '127.0.0.1';
        const pipe = await connectTcp(hostname, options.port);

        // create SSL context
        const ctx = new ssl.Context({
            alpn: options.alpnProtocols,
            ca: caCertsPem(options.caCerts),
            cert: tlsOptions.cert,
            key: tlsOptions.key,
            verify: true,
            verifyHostname: !options.unsafelyDisableHostnameVerification,
            mode: 'client'
        });
        const sslpipe = new ssl.Pipe(ctx, {
            servername: normalizeHostname(hostname)
        });

        return toConn(sslpipe, pipe);
    },

    // @ts-ignore
    listen(opt) {
        switch (opt.transport) {
            case undefined:
            case 'tcp':
                const bindHost = normalizeHostname(opt.hostname ?? '0.0.0.0');
                const isV4 = !isIPv6Hostname(bindHost);
                const tcp = new stream.TCP(isV4 ? os.AF_INET : os.AF_INET6);
                tcp.bind({
                    ip: bindHost,
                    port: opt.port
                })
                tcp.listen(opt.tcpBacklog);
                return new TcpListener(tcp, true, {
                    hostname: bindHost,
                    port: opt.port,
                    transport: 'tcp'
                });
            case 'unix':
                const unix = new stream.Pipe();
                unix.bind(opt.path);
                unix.listen();
                return new Listener(unix, false, {
                    path: opt.path,
                    transport: 'unix'
                });
            default:
                throw new Deno.errors.NotSupported(`Unsupported transport: ${opt.transport}`);
        }
    },

    listenTls(opt) {
        if (opt.keyFormat && opt.keyFormat !== 'pem')
            throw new TypeError(`Unsupported key format: ${opt.keyFormat}`);
        const bindHost = normalizeHostname(opt.hostname ?? '0.0.0.0');
        const isV4 = !isIPv6Hostname(bindHost);
        const tcp = new stream.TCP(isV4 ? os.AF_INET : os.AF_INET6);
        tcp.bind({
            ip: bindHost,
            port: opt.port
        })
        tcp.listen(opt.tcpBacklog);
        const ctx = new ssl.Context({
            alpn: opt.alpnProtocols,
            cert: opt.cert,
            key: opt.key,
            mode: 'server'
        });
        const listener = new TlsListener(tcp, {
            hostname: bindHost,
            port: opt.port,
            transport: 'tcp'
        }, ctx);
        return listener;
    },

    async startTls(conn, opt) {
        // @ts-ignore
        const pipe = conn[symbolTakePipe]?.() as CModuleStreams.TCP;
        if (!pipe) throw new Deno.errors.BadResource('Connection is not a TCP connection');
        const hostname = opt?.hostname ? normalizeHostname(opt.hostname) : '127.0.0.1';
        const sslctx = new ssl.Context({
            alpn: opt?.alpnProtocols,
            ca: caCertsPem(opt?.caCerts),
            verify: true,
            verifyHostname: !opt?.unsafelyDisableHostnameVerification,
            mode: 'client'
        });
        const sslpipe = new ssl.Pipe(sslctx, {
            servername: hostname
        });
        return toConn(sslpipe, pipe);
    }
}));
