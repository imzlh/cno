import { malloc } from "../utils/malloc";
import { wrapFsClassDec as wrap, wrapFSErr, wrapFSns } from "../utils/wrap";
import { DOMException } from "../webapi/events";

const os = import.meta.use('os');
const stream = import.meta.use('streams');
const ssl = import.meta.use('ssl');
const dns = import.meta.use('dns');
const udp = import.meta.use('udp');
const windows = import.meta.use('win32');
const timers = import.meta.use('timers');
const error = import.meta.use('error');
const algo = import.meta.use('algorithm');

import { dnsCache } from '@cnojs/http/dns-cache';
import { errors } from "./01_errors";
import { systemDnsServers } from "../utils/osdns";

const DEFAULT_TCP_KEEPALIVE_INITIAL_DELAY = 60;

const symbolTakePipe = Symbol('Stream.takePipe');
type TakePipe = () => CModuleStreams.Stream;

function closeStreamQuietly(pipe: CModuleStreams.Stream): void {
    try {
        pipe.close();
    } catch {
        // Closing stale pending sockets is best-effort during teardown/racing.
    }
}

export const useWritable = (pipe: CModuleStreams.Stream) => new WritableStream({
    write: async (chunk, control) => {
        try {
            await pipe.write(chunk);
        } catch (e) {
            control.error(wrapFSErr(e));
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
            controller.error(wrapFSErr(e));
        }
    }
});

const kRawPipe = Symbol('Stream.rawPipe');

class Conn<T extends Deno.Addr = Deno.Addr> implements Deno.Conn<T> {
    protected $readable: ReadableStream;
    protected $writable: WritableStream;
    protected $consumed = false;
    private $readOps = 0;
    private $writeOps = 0;
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
        if (this.$consumed) throw new errors.BadResource('Connection has been consumed');
    }

    @wrap
    async read(p: Uint8Array): Promise<number | null> {
        this.assertUsable();
        this.$readOps++;
        try {
            const n = await this.pipe.read(p);
            return n === 0 ? null : n;
        } finally {
            this.$readOps--;
        }
    }

    @wrap
    async write(p: Uint8Array): Promise<number> {
        this.assertUsable();
        this.$writeOps++;
        try {
            return await this.pipe.write(p);
        } finally {
            this.$writeOps--;
        }
    }

    @wrap
    close(): void {
        if (this.$consumed) return;
        this.pipe.close();
    }

    @wrap
    async closeWrite(): Promise<void> {
        this.assertUsable();
        this.$writeOps++;
        try {
            return await this.pipe.shutdown();
        } finally {
            this.$writeOps--;
        }
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
        if (this.$readOps > 0 || this.$writeOps > 0 || this.$readable.locked || this.$writable.locked) {
            throw new errors.Busy('Connection is in use');
        }
        this.$consumed = true;
        return this.pipe;
    }
}

const addrinfo2deno = (info: CModuleStreams.AddressInfo, transport: 'tcp' | 'udp' = 'tcp'): Deno.NetAddr => ({
    transport,
    hostname: info.ip,
    port: info.port
});

type ConnectTlsRuntimeOptions = Deno.ConnectTlsOptions & Partial<Deno.TlsCertifiedKeyPem> & {
    signal?: AbortSignal;
};
type ConnectRuntimeOptions = Deno.ConnectOptions | Deno.UnixConnectOptions | Deno.VsockConnectOptions;
type ListenRuntimeOptions =
    | (Deno.TcpListenOptions & { transport?: 'tcp' })
    | (Deno.UnixListenOptions & { transport: 'unix' })
    | (Deno.VsockListenOptions & { transport: 'vsock' });

function denoConnect(options: Deno.ConnectOptions): Promise<Deno.TcpConn>;
function denoConnect(options: Deno.UnixConnectOptions): Promise<Deno.UnixConn>;
function denoConnect(options: Deno.VsockConnectOptions): Promise<Deno.VsockConn>;
async function denoConnect(options: ConnectRuntimeOptions): Promise<Deno.TcpConn | Deno.UnixConn | Deno.VsockConn> {
    switch (options.transport) {
        case undefined:
        case 'tcp':
            return new TcpConn(await connectTcp(options.hostname ?? '127.0.0.1', options.port, options.signal));
        case 'unix':
            const unix = new stream.Pipe();
            await unix.connect(options.path);
            return new UnixConn(unix, options.path);
        default:
            throw new errors.NotSupported(`Unsupported transport: ${options.transport}`);
    }
}

function validateListenPort(port: unknown, defaultPort: number): number {
    const value = port ?? defaultPort;
    const numericPort = Number(value);
    if (!Number.isInteger(numericPort))
        throw new TypeError(`Invalid port: ${value}`);
    if (numericPort < 0 || numericPort > 65535)
        throw new RangeError(`Invalid port (out of range): ${value}`);
    return numericPort;
}

function denoListen(opt: Deno.TcpListenOptions & { transport?: 'tcp' }): Deno.TcpListener;
function denoListen(opt: Deno.UnixListenOptions & { transport: 'unix' }): Deno.UnixListener;
function denoListen(opt: Deno.VsockListenOptions & { transport: 'vsock' }): Deno.VsockListener;
function denoListen(opt: ListenRuntimeOptions): Deno.TcpListener | Deno.UnixListener | Deno.VsockListener {
    switch (opt.transport) {
        case undefined:
        case 'tcp':
            const bindHost = normalizeHostname(opt.hostname ?? '0.0.0.0');
            const isV4 = !isIPv6Hostname(bindHost);
            const tcp = new stream.TCP(isV4 ? os.AF_INET : os.AF_INET6);
            tcp.bind({
                ip: bindHost,
                port: validateListenPort(opt.port, 80)
            })
            tcp.listen(opt.tcpBacklog);
            return new TcpListener(tcp, true, addrinfo2deno(tcp.sockname));
        case 'unix':
            const unix = new stream.Pipe();
            unix.bind(opt.path);
            unix.listen();
            return new UnixListener(unix, false, {
                path: opt.path,
                transport: 'unix'
            });
        default:
            throw new errors.NotSupported(`Unsupported transport: ${opt.transport}`);
    }
}

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
        (this.pipe as CModuleStreams.TCP).setKeepAlive(!!keepAlive, DEFAULT_TCP_KEEPALIVE_INITIAL_DELAY);
    }
}

class TlsConn implements Deno.TlsConn {
    private static readonly READ_HIGH_WATER = 256 * 1024;
    private static readonly READ_LOW_WATER = 128 * 1024;

    private $readable: ReadableStream;
    private $writable: WritableStream;
    private $handshake: Promise<Deno.TlsHandshakeInfo>;
    private $handshakeResolve: (info: Deno.TlsHandshakeInfo) => void;
    private $handshakeReject: (err: unknown) => void;
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
        const handshake = Promise.withResolvers<Deno.TlsHandshakeInfo>();
        this.$handshake = handshake.promise;
        this.$handshakeResolve = handshake.resolve;
        this.$handshakeReject = handshake.reject;
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
                    controller.error(wrapFSErr(e));
                }
            }
        });
        this.$writable = new WritableStream({
            write: async (chunk, control) => {
                try {
                    await this.$handshake;
                    let written = 0;
                    let retries = 0;
                    while (written < chunk.length) {
                        const n = $pipe.write(chunk.subarray(written));
                        if (n === null) {
                            if (++retries > 100) throw new Error('TLS write stall');
                            await this.output();
                            await this.waitForTlsProgress();
                            continue;
                        }
                        retries = 0;
                        written += n;
                        await this.output();
                    }
                } catch (e) {
                    control.error(wrapFSErr(e));
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
            if (!this.$handshakeDone) this.$handshakeReject(error.Error(error.errno.EOF));
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
        waiters.forEach(waiter => waiter.resolve());
    }

    private wakeTlsWaiters(): void {
        const waiters = this.$tlsWaiters.splice(0);
        waiters.forEach(waiter => waiter.resolve());
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
        Reflect.set(this.$rawPipe, 'onread', null);
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
            const chunk = this.$readQueue[0];
            if (!chunk) break;
            const n = Math.min(chunk.byteLength, p.byteLength - copied);
            p.set(chunk.subarray(0, n), copied);
            copied += n;
            this.$readQueueSize -= n;
            if (n === chunk.byteLength) {
                this.$readQueue.shift();
            } else {
                this.$readQueue[0] = chunk.slice(n);
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

class UdpDatagramConn implements Deno.DatagramConn {
    private $closed = false;

    constructor(
        private readonly handle: CModuleUDP.UDP,
        public readonly addr: Deno.NetAddr,
    ) { }

    joinMulticastV4(): Promise<Deno.MulticastV4Membership> {
        return Promise.reject(new errors.NotSupported('UDP multicast is not supported'));
    }

    joinMulticastV6(): Promise<Deno.MulticastV6Membership> {
        return Promise.reject(new errors.NotSupported('UDP multicast is not supported'));
    }

    @wrap
    async receive(p?: Uint8Array): Promise<[Uint8Array<ArrayBuffer>, Deno.Addr]> {
        if (this.$closed) throw new errors.BadResource('Datagram socket has been closed');
        const buf = p ?? new Uint8Array(65536);
        const { nread, addr } = await this.handle.recv(buf);
        const data = new Uint8Array(nread);
        data.set(buf.subarray(0, nread));
        return [data, addrinfo2deno(addr, 'udp')];
    }

    @wrap
    send(p: Uint8Array, addr: Deno.Addr): Promise<number> {
        if (this.$closed) throw new errors.BadResource('Datagram socket has been closed');
        if (addr.transport !== 'udp') throw new errors.NotSupported(`Unsupported datagram transport: ${addr.transport}`);
        return this.handle.send(p, { ip: addr.hostname, port: addr.port });
    }

    close(): void {
        if (this.$closed) return;
        this.$closed = true;
        this.handle.close();
    }

    async *[Symbol.asyncIterator](): AsyncIterableIterator<[Uint8Array<ArrayBuffer>, Deno.Addr]> {
        try {
            while (true) {
                yield await this.receive();
            }
        } catch (e) {
            if (this.$closed) return;
            throw e;
        }
    }
}

class Listener implements Deno.Listener {
    private $acceptQueue: CModuleStreams.Stream[] = [];
    private $acceptPromise?: PromiseWithResolvers<CModuleStreams.Stream>;
    protected $closed = false;

    constructor(
        protected $pipe: CModuleStreams.Stream,
        protected $isTCP: boolean,
        protected $addr: Deno.Addr
    ) {
        $pipe.onconnection = (err, client) => {
            if (this.$closed) {
                if (client) closeStreamQuietly(client);
                return;
            }
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
        if (this.$acceptPromise) {
            throw new errors.Busy('Listener already in use');
        }
        let conn = this.$acceptQueue.shift();
        if (!conn) {
            if (this.$closed) throw new errors.BadResource('Listener has been closed');
            this.$acceptPromise = Promise.withResolvers();
            const acceptPromise = this.$acceptPromise;
            try {
                conn = await acceptPromise.promise;
            } finally {
                if (this.$acceptPromise === acceptPromise) this.$acceptPromise = undefined;
            }
        }
        return this.$isTCP
            ? new TcpConn(conn as CModuleStreams.TCP)
            : new UnixConn(conn as CModuleStreams.Pipe, (this.$addr as Deno.UnixAddr).path);
    }

    close(): void {
        if (this.$closed) return;
        this.$closed = true;
        const pending = this.$acceptPromise;
        this.$acceptPromise = undefined;
        if (pending) pending.reject(new errors.BadResource('Listener has been closed'));
        for (const conn of this.$acceptQueue.splice(0)) {
            closeStreamQuietly(conn);
        }
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
        try {
            while (true) {
                try {
                    const conn = await this.accept();
                    yield conn;
                } catch (e) {
                    if (this.$closed && e instanceof errors.BadResource) return;
                    throw e;
                }
            }
        } finally {
            this.close();
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

const isAddressAnswer = (answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.AddressAnswer =>
    answer.type === dns.A || answer.type === dns.AAAA;
const isCNameAnswer = (answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.CNameAnswer => answer.type === dns.CNAME;
const isNsAnswer = (answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.NsAnswer => answer.type === dns.NS;
const isPtrAnswer = (answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.PtrAnswer => answer.type === dns.PTR;
const isCaaAnswer = (answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.CaaAnswer => answer.type === dns.CAA;
const isMxAnswer = (answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.MxAnswer => answer.type === dns.MX;
const isNaptrAnswer = (answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.NaptrAnswer => answer.type === dns.NAPTR;
const isSoaAnswer = (answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.SoaAnswer => answer.type === dns.SOA;
const isSrvAnswer = (answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.SrvAnswer => answer.type === dns.SRV;
const isTxtAnswer = (answer: CModuleDNS.DNSAnswer): answer is CModuleDNS.TxtAnswer => answer.type === dns.TXT;

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
    let onAbort: (() => void) | undefined;
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
        if (onAbort) signal.removeEventListener('abort', onAbort);
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
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
}

let systemCaPemCache: string | null | undefined;

function systemCaPem(): string | undefined {
    if (systemCaPemCache !== undefined) return systemCaPemCache ?? undefined;
    systemCaPemCache = null;
    if (os.platform === 'win32') {
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

/** True if the string looks like a bare IPv4 or IPv6 address literal. */
function isIpLiteral(host: string): boolean {
    // IPv6 literals arrive as "[::1]" or "::1"
    const h = normalizeHostname(host);
    // IPv4: four octets
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    // IPv6: contains ':'
    if (h.includes(':')) return true;
    return false;
}

async function connectTcp(hostname: string, port: number, signal?: AbortSignal): Promise<CModuleStreams.TCP> {
    if (signal?.aborted) throw abortReason(signal);
    const host = normalizeHostname(hostname);

    // If the caller passed a literal IP, connect directly (no dual-stack logic needed).
    if (isIpLiteral(host)) {
        const family = host.includes(':') ? 6 : 4;
        const tcp = new stream.TCP(family === 6 ? os.AF_INET6 : os.AF_INET);
        await withAbort(tcp.connect({ ip: host, port }), signal, () => tcp.close());
        return tcp;
    }

    // Happy Eyeballs (RFC 8305): resolve both A + AAAA, race connections with
    // a 250 ms head-start for IPv6.
    const HAPPY_EYEBALLS_DELAY = 250;

    const [v6addrs, v4addrs] = await Promise.all([
        withAbort(dnsCache.resolve(host, { family: 6 }), signal).catch(() => []),
        withAbort(dnsCache.resolve(host, { family: 4 }), signal).catch(() => []),
    ]);

    const v6ip = v6addrs[0]?.ip;
    const v4ip = v4addrs[0]?.ip;

    if (!v6ip && !v4ip) throw new Error(`Could not resolve hostname ${host}`);

    // Only one family resolved — connect directly.
    if (!v6ip) {
        if (!v4ip) throw new Error(`Could not resolve hostname ${host}`);
        const tcp = new stream.TCP(os.AF_INET);
        await withAbort(tcp.connect({ ip: v4ip, port }), signal, () => tcp.close());
        return tcp;
    }
    if (!v4ip) {
        const tcp = new stream.TCP(os.AF_INET6);
        await withAbort(tcp.connect({ ip: v6ip, port }), signal, () => tcp.close());
        return tcp;
    }

    // Both families available — race with Happy Eyeballs delay.
    return new Promise<CModuleStreams.TCP>((resolve, reject) => {
        let settled = false;
        let v4started = false;
        let failCount = 0;
        let lastError: unknown;
        let v4timer: ReturnType<typeof timers.setTimeout> | undefined;
        const tcpV6 = new stream.TCP(os.AF_INET6);
        const tcpV4 = new stream.TCP(os.AF_INET);

        function cancelTimer() {
            if (v4timer !== undefined) {
                timers.clearTimeout(v4timer);
                v4timer = undefined;
            }
        }

        function win(tcp: CModuleStreams.TCP) {
            if (settled) return;
            settled = true;
            cancelTimer();
            const loser = tcp === tcpV6 ? tcpV4 : tcpV6;
            closeStreamQuietly(loser);
            resolve(tcp);
        }

        function startV4() {
            if (v4started || settled) return;
            v4started = true;
            cancelTimer();
            withAbort(tcpV4.connect({ ip: v4ip, port }), signal, () => tcpV4.close())
                .then(() => win(tcpV4), onFail);
        }

        function onFail(err: unknown) {
            if (settled) return;
            lastError = err;
            failCount++;
            if (!v4started) {
                // v6 failed before the delay fired — start v4 immediately
                startV4();
                return;
            }
            if (failCount >= 2) {
                // Both failed
                settled = true;
                reject(lastError);
            }
        }

        // Start IPv6 immediately
        withAbort(tcpV6.connect({ ip: v6ip, port }), signal, () => tcpV6.close())
            .then(() => win(tcpV6), onFail);

        // Start IPv4 after HAPPY_EYEBALLS_DELAY ms
        v4timer = timers.setTimeout(startV4, HAPPY_EYEBALLS_DELAY);
    });
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
        try {
            while (true) {
                try {
                    const conn = await this.accept();
                    yield conn;
                } catch (e) {
                    if (this.$closed && e instanceof errors.BadResource) return;
                    throw e;
                }
            }
        } finally {
            this.close();
        }
    }
}

class UnixListener extends Listener implements Deno.UnixListener {
    get addr(): Deno.UnixAddr {
        return this.$addr as Deno.UnixAddr;
    }

    @wrap
    accept(): Promise<Deno.UnixConn> {
        return super.accept() as Promise<Deno.UnixConn>;
    }

    @wrap
    async*[Symbol.asyncIterator]() {
        try {
            while (true) {
                try {
                    const conn = await this.accept();
                    yield conn;
                } catch (e) {
                    if (this.$closed && e instanceof errors.BadResource) return;
                    throw e;
                }
            }
        } finally {
            this.close();
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
        return toConn(sslpipe, Reflect.get(conn, kRawPipe) as CModuleStreams.TCP);
    }

    @wrap
    async*[Symbol.asyncIterator]() {
        try {
            while (true) {
                try {
                    const conn = await this.accept();
                    yield conn;
                } catch (e) {
                    if (this.$closed && e instanceof errors.BadResource) return;
                    throw e;
                }
            }
        } finally {
            this.close();
        }
    }

    get addr(): Deno.NetAddr {
        return this.$addr as Deno.NetAddr;
    }
}

function countBits(value: number): number {
    let count = 0;
    let n = value;
    while (n > 0) {
        count += n & 1;
        n >>>= 1;
    }
    return count;
}



function ipv4PrefixLength(netmask: string): number {
    const octets = netmask.split('.').map(Number);
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return 32;
    return octets.reduce((bits, octet) => bits + countBits(octet), 0);
}

function ipv6PrefixLength(netmask: string): number {
    const parts = netmask.split(':');
    if (parts.length < 2) return 128;
    return parts.reduce((bits, part) => {
        if (part === '') return bits;
        const value = Number.parseInt(part, 16);
        return Number.isFinite(value) ? bits + countBits(value) : bits;
    }, 0);
}

function interfaceCidr(info: ReturnType<typeof os.networkInterfaces>[number]): string {
    const nativeCidr = Reflect.get(info, 'cidr');
    if (nativeCidr) return nativeCidr;
    const isIPv6 = info.address.includes(':');
    const prefix = isIPv6 ? ipv6PrefixLength(info.netmask) : ipv4PrefixLength(info.netmask);
    return `${info.address}/${prefix}`;
}

const denoNetNs = {
    networkInterfaces() {
        const intf = os.networkInterfaces();
        return intf.map((i): Deno.NetworkInterfaceInfo => {
            const family: 'IPv4' | 'IPv6' = i.address.includes(':') ? 'IPv6' : 'IPv4';
            return {
                ...i,
                family,
                scopeid: i.scopeId ?? null,
                cidr: interfaceCidr(i)
            };
        });
    },
    resolveDns: (async (query: string, type: Deno.RecordType = 'A', opt?: Deno.ResolveDnsOptions) => {
        if (opt?.signal?.aborted) throw abortReason(opt.signal);
        let server: undefined | string;
        let port: undefined | number;
        if (opt?.nameServer) {
            server = opt.nameServer.ipAddr;
            port = opt.nameServer.port;
            if (port !== undefined && (port <= 0 || port > 65535))
                throw new RangeError('Invalid DNS nameServer port');
        } else {
            server = systemDnsServers()[0];
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

        if (!opt?.nameServer && (type === 'A' || type === 'AAAA')) {
            try {
                const addresses = await withTimeoutAbort(
                    dns.resolve(query, { family: type === 'A' ? os.AF_INET : os.AF_INET6 }),
                    5000,
                    opt?.signal,
                );
                if (addresses.length === 0) throw new errors.NotFound(`No ${type} records found for ${query}`);
                return addresses.map(address => address.ip);
            } catch (cause) {
                const code = (cause as { code?: string })?.code;
                if (code === 'ENOTFOUND' || code === 'EAI_NONAME' || code === 'EAI_NODATA') {
                    throw new errors.NotFound(`No ${type} records found for ${query}`);
                }
                throw cause;
            }
        }

        let info: CModuleDNS.DNSAnswer[];
        try {
            const request = dns.query(query, nativeType, server, port);
            info = await withTimeoutAbort(request, 5000, opt?.signal, () => request.abort?.());
        } catch (cause) {
            const code = (cause as { code?: string })?.code;
            if (code === 'ENOTFOUND' || code === 'ENODATA') {
                throw new errors.NotFound(`No ${type} records found for ${query}`);
            }
            throw cause;
        }
        switch (type) {
            case 'A':
            case 'AAAA':
                return info.filter(isAddressAnswer).filter(i => i.type === nativeType).map(i => i.address);
            case 'ANAME':
            case 'CNAME':
                return info.filter(isCNameAnswer).map(i => i.cname);
            case 'NS':
                return info.filter(isNsAnswer).map(i => i.ns);
            case 'PTR':
                return info.filter(isPtrAnswer).map(i => i.ptr);
            case "CAA":
                return info.filter(isCaaAnswer).map(i => ({
                    critical: (i.flags & 0x80) !== 0,
                    tag: i.tag,
                    value: i.value
                } satisfies Deno.CaaRecord));
            case "MX":
                return info.filter(isMxAnswer).map(i => ({
                    exchange: i.exchange,
                    preference: i.priority
                } satisfies Deno.MxRecord));
            case "NAPTR":
                return info.filter(isNaptrAnswer).map(i => ({
                    flags: i.flags,
                    order: i.order,
                    preference: i.preference,
                    regexp: i.regexp,
                    replacement: i.replacement,
                    services: i.services
                } satisfies Deno.NaptrRecord));
            case "SOA":
                return info.filter(isSoaAnswer).map(i => ({
                    expire: i.expire,
                    refresh: i.refresh,
                    retry: i.retry,
                    serial: i.serial,
                    minimum: i.minimum,
                    mname: i.primary,
                    rname: i.admin
                } satisfies Deno.SoaRecord));
            case "SRV":
                return info.filter(isSrvAnswer).map(i => ({
                    port: i.port,
                    priority: i.priority,
                    target: i.target,
                    weight: i.weight
                } satisfies Deno.SrvRecord));
            case "TXT":
                return info.filter(isTxtAnswer).map(i => decodeTxtRecord(i.txt));
            default:
                throw new Error(`Unsupported DNS record type: ${type}`);
        }
    }) as typeof Deno.resolveDns,

    connect: denoConnect,

    async connectTls(options: ConnectTlsRuntimeOptions) {
        if (options.keyFormat && options.keyFormat !== 'pem')
            throw new TypeError(`Unsupported key format: ${options.keyFormat}`);
        const hostname = options.hostname ?? '127.0.0.1';
        const pipe = await connectTcp(hostname, options.port, options.signal);

        // create SSL context
        const ctx = new ssl.Context({
            alpn: options.alpnProtocols,
            ca: caCertsPem(options.caCerts),
            cert: options.cert,
            key: options.key,
            verify: true,
            verifyHostname: !options.unsafelyDisableHostnameVerification,
            mode: 'client'
        });
        const sslpipe = new ssl.Pipe(ctx, {
            servername: normalizeHostname(hostname)
        });

        return toConn(sslpipe, pipe);
    },

    listen: denoListen,

    listenTls(opt: Deno.ListenTlsOptions & Deno.TlsCertifiedKeyPem) {
        if (opt.keyFormat && opt.keyFormat !== 'pem')
            throw new TypeError(`Unsupported key format: ${opt.keyFormat}`);
        const bindHost = normalizeHostname(opt.hostname ?? '0.0.0.0');
        const isV4 = !isIPv6Hostname(bindHost);
        const tcp = new stream.TCP(isV4 ? os.AF_INET : os.AF_INET6);
        tcp.bind({
            ip: bindHost,
            port: validateListenPort(opt.port, 443)
        })
        tcp.listen(opt.tcpBacklog);
        const ctx = new ssl.Context({
            alpn: opt.alpnProtocols,
            cert: opt.cert,
            key: opt.key,
            mode: 'server'
        });
        const listener = new TlsListener(tcp, addrinfo2deno(tcp.sockname), ctx);
        return listener;
    },

    async startTls(conn: Deno.TcpConn, opt?: Deno.StartTlsOptions) {
        const takePipe = Reflect.get(conn, symbolTakePipe) as TakePipe | undefined;
        const pipe = takePipe?.call(conn) as CModuleStreams.TCP | undefined;
        if (!pipe) throw new errors.BadResource('Connection is not a TCP connection');
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
    },

    listenDatagram(opt: (Deno.UdpListenOptions & { transport: 'udp' }) | (Deno.UnixListenDatagramOptions & { transport: 'unixpacket' })) {
        switch (opt.transport) {
            case 'udp': {
                const bindHost = normalizeHostname(opt.hostname ?? '127.0.0.1');
                const socket = new udp.UDP();
                socket.bind(
                    { ip: bindHost, port: opt.port ?? 0 },
                    opt.reuseAddress ? udp.UDP_REUSEADDR : 0,
                );
                return new UdpDatagramConn(socket, addrinfo2deno(socket.getsockname(), 'udp'));
            }
            case 'unixpacket':
                throw new errors.NotSupported('Unix packet datagrams are not supported');
            default:
                throw new errors.NotSupported('Unsupported datagram transport');
        }
    }
};

Object.assign(Deno, wrapFSns(denoNetNs));
