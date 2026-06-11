import { malloc } from "../utils/malloc";
import { wrapFsClassDec as wrap, wrapFSErr, wrapFSns } from "../utils/wrap";

const os = import.meta.use('os');
const stream = import.meta.use('streams');
const ssl = import.meta.use('ssl');
const dns = import.meta.use('dns');

import { dnsCache } from '@cnojs/http/dns-cache';

const symbolGetPipe = Symbol('Stream.getPipe');

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

    @wrap
    read(p: Uint8Array): Promise<number | null> {
        return this.pipe.read(p).then(n => n === 0 ? null : n);
    }

    @wrap
    write(p: Uint8Array): Promise<number> {
        return this.pipe.write(p);
    }

    @wrap
    close(): void {
        this.pipe.close();
    }

    @wrap
    async closeWrite(): Promise<void> {
        return this.pipe.shutdown();
    }

    ref(): void {
        // TODO
    }

    unref(): void {
        // TODO
    }

    get readable(): ReadableStream {
        return this.$readable;
    }

    get writable(): WritableStream {
        return this.$writable;
    }

    @wrap
    [Symbol.dispose]() {
        return this.pipe.close();
    }

    [symbolGetPipe]() {
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
    private $readable: ReadableStream;
    private $writable: WritableStream;
    readonly localAddr: Deno.NetAddr;
    readonly remoteAddr: Deno.NetAddr;

    constructor(
        protected $pipe: CModuleSSL.Pipe,
        protected $rawPipe: CModuleStreams.TCP,
        protected $handshake: Promise<Deno.TlsHandshakeInfo>
    ) {
        const pipe = $pipe;
        this.$readable = new ReadableStream({
            async pull(controller) {
                try {
                    const buf = malloc(controller);
                    const data = pipe.read(buf.byteLength);
                    if (data === null || data.byteLength === 0) {
                        controller.close();
                    } else {
                        buf.set(new Uint8Array(data));
                        controller.enqueue(buf.slice(0, data.byteLength));
                    }
                } catch (e) {
                    controller.error(wrapFSErr(e as any));
                }
            }
        });
        this.$writable = new WritableStream({
            write: async (chunk, control) => {
                try {
                    let written = 0;
                    while (written < chunk.length) {
                        const n = $pipe.write(chunk.subarray(written));
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
    }

    @wrap
    private output() {
        const obuf = this.$pipe.getOutput();
        if (!obuf || obuf.byteLength === 0) return;
        const buf = new Uint8Array(obuf);
        return this.$rawPipe.write(buf);
    }

    get readable(): ReadableStream {
        return this.$readable;
    }

    get writable(): WritableStream {
        return this.$writable;
    }

    @wrap
    async close(): Promise<void> {
        return this.$rawPipe.close();
    }

    handshake(): Promise<Deno.TlsHandshakeInfo> {
        return this.$handshake;
    }

    ref(): void {
        // TODO
    }

    unref(): void {
        // TODO
    }

    @wrap
    async read(p: Uint8Array): Promise<number | null> {
        const buf = this.$pipe.read(p.byteLength);
        if (buf === null) return null;
        p.set(new Uint8Array(buf));
        return buf.byteLength;
    }

    @wrap
    async write(p: Uint8Array): Promise<number> {
        const r = this.$pipe.write(p);
        await this.output();
        return r;
    }

    @wrap
    async closeWrite(): Promise<void> {
        return this.$rawPipe.shutdown();
    }

    @wrap
    [Symbol.dispose]() {
        this.$rawPipe.close();
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
        // TODO
    }

    unref(): void {
        // TODO
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
    let handshake = false;
    return new TlsConn(sslpipe, pipe, new Promise<Deno.TlsHandshakeInfo>((resolve, reject) => {
        pipe.onread = (res, err) => {
            if (!res){
                reject(err ?? (new Error('TLS failed to handshake: EOF')));
                pipe.stopRead();
                return;
            }
            sslpipe.feed(res);
            if (!handshake && sslpipe.handshake()) {
                handshake = true;
                pipe.stopRead();
                // @ts-ignore
                pipe.onread = null;
                resolve({
                    alpnProtocol: sslpipe.alpnProtocol()
                });
            }
        }
        pipe.startRead();
    }));
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
    async resolveDns(query, type, opt) {
        let server: undefined | string;
        if (opt?.nameServer) {
            server = `${opt.nameServer.ipAddr}`;
            if (opt.nameServer.port)
                server += `:${opt.nameServer.port}`;
        }

        const info = await dns.query(query);
        switch (type) {
            case 'A':
            case "AAAA":
            case "CNAME":
            case "NS":
            case "PTR":
                return info.filter((i: any) => i.type == dns[type]).map((i: any) => i.name);
            case "CAA":
                // @ts-ignore
                return info.filter<CModuleDNS.CaaAnswer>(i => i.type == dns.CAA).map(i => ({
                    critical: i.ttl === 0,
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
                    minimum: i.ttl,
                    mname: i.admin,
                    rname: i.name
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
                return info.filter<CModuleDNS.TxtAnswer>(i => i.type == dns.TXT).map(i => i.text);
            default:
                throw new Error(`Unsupported DNS record type: ${type}`);
        }
    },

    // @ts-ignore
    async connect(options) {
        switch (options.transport) {
            case undefined:
            case 'tcp':
                const host = options.hostname ?? '0.0.0.0';
                const tcp = new stream.TCP(host.includes(':') ? os.AF_INET6 : os.AF_INET);
                const dnsanswer = await dnsCache.resolve(host, { family: host.includes(':') ? 6 : 4 });
                const ip = dnsanswer[0]?.ip;
                if (!ip) throw new Error(`Could not resolve hostname ${host}`);
                await tcp.connect({ ip, port: options.port });
                return new TcpConn(tcp);
            case 'unix':
                const unix = new stream.Pipe();
                await unix.connect(options.path);
                return new UnixConn(unix, options.path);
            default:
                throw new Deno.errors.NotSupported(`Unsupported transport: ${options.transport}`);
        }
    },

    async connectTls(options) {
        const af4 = !options.hostname?.includes(':');
        const pipe = new stream.TCP(af4 ? os.AF_INET : os.AF_INET6);
        await pipe.connect({ ip: options.hostname ?? '0.0.0.0', port: options.port });

        // create SSL context
        const ctx = new ssl.Context({
            alpn: options.alpnProtocols,
            ca: options.caCerts?.[0],
            verify: !options.unsafelyDisableHostnameVerification,
            mode: 'client'
        });
        const sslpipe = new ssl.Pipe(ctx, {
            servername: options.hostname
        });

        return toConn(sslpipe, pipe);
    },

    // @ts-ignore
    listen(opt) {
        switch (opt.transport) {
            case undefined:
            case 'tcp':
                const isV4 = !opt.hostname?.includes(':');
                const tcp = new stream.TCP(isV4 ? os.AF_INET : os.AF_INET6);
                tcp.bind({
                    ip: opt.hostname ?? '0.0.0.0',
                    port: opt.port
                })
                tcp.listen(opt.tcpBacklog);
                return new TcpListener(tcp, true, {
                    hostname: opt.hostname ?? '0.0.0.0',
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
        const isV4 = !opt.hostname?.includes(':');
        const tcp = new stream.TCP(isV4 ? os.AF_INET : os.AF_INET6);
        tcp.bind({
            ip: opt.hostname ?? '0.0.0.0',
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
            hostname: opt.hostname ?? '0.0.0.0',
            port: opt.port,
            transport: 'tcp'
        }, ctx);
        return listener;
    },

    async startTls(conn, opt) {
        // @ts-ignore
        const pipe = conn[symbolGetPipe]?.() as CModuleStreams.TCP;
        const sslctx = new ssl.Context({
            alpn: opt?.alpnProtocols,
            ca: opt?.caCerts?.[0],
            verify: !opt?.unsafelyDisableHostnameVerification,
            mode: 'client'
        });
        const sslpipe = new ssl.Pipe(sslctx, {
            servername: opt?.hostname
        });
        return toConn(sslpipe, pipe);
    }
}));