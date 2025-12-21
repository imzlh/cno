const os = import.meta.use('os');
const dns = import.meta.use('dns');
const stream = import.meta.use('streams');
const ssl = import.meta.use('ssl');

const symbolGetPipe = Symbol('Stream.getPipe');

export const useWritable = (pipe: CModuleStreams.Stream) => new WritableStream({
    write: async (chunk, control) => {
        try {
            let written = 0;
            while (written < chunk.length) {
                const n = await pipe.write(chunk.subarray(written));
                written += n;
            }
        } catch (e) {
            control.error(e);
        }
    }
});

export const useReadable = (pipe: CModuleStreams.Stream) => new ReadableStream({
    async pull(controller) {
        try {
            const buf = new Uint8Array(controller.desiredSize ?? 1024);
            const n = await pipe.read(buf);
            if (n === null) {
                controller.close();
            } else {
                controller.enqueue(buf.subarray(0, n));
            }
        } catch (e) {
            controller.error(e);
        }
    }
});

class Conn<T extends Deno.Addr = Deno.Addr> implements Deno.Conn<T> {
    protected $readable: ReadableStream;
    protected $writable: WritableStream;

    constructor(
        protected readonly pipe: CModuleStreams.Stream,
        public readonly localAddr: T,
        public readonly remoteAddr: T
    ) {
        this.$readable = useReadable(pipe);
        this.$writable = useWritable(pipe);
    }

    async read(p: Uint8Array): Promise<number | null> {
        return this.pipe.read(p);
    }

    write(p: Uint8Array): Promise<number> {
        return this.pipe.write(p);
    }

    close(): void {
        this.pipe.close();
    }

    closeWrite(): Promise<void> {
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

    [Symbol.dispose]() {
        return this.pipe.close();
    }

    [symbolGetPipe](){
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
        super(pipe, addrinfo2deno(pipe.getsockname()), addrinfo2deno(pipe.getpeername()));
    }

    setNoDelay(noDelay?: boolean): void {
        (this.pipe as CModuleStreams.TCP).setNoDelay(noDelay ?? false);
    }

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
        this.$readable = new ReadableStream({
            async pull(controller) {
                try {
                    const buf = $pipe.read(controller.desiredSize ?? 1024);
                    if (buf === null) {
                        controller.close();
                    } else {
                        controller.enqueue(buf);
                    }
                } catch (e) {
                    controller.error(e);
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
                    control.error(e);
                }
            }
        });
        this.localAddr = addrinfo2deno(this.$rawPipe.getsockname());
        this.remoteAddr = addrinfo2deno(this.$rawPipe.getpeername());
    }

    private async output() {
        const obuf = this.$pipe.getOutput();
        if (!obuf || obuf.byteLength === 0) return;
        const buf = new Uint8Array(obuf);
        let written = 0;
        while (written < buf.byteLength) {
            const n = await this.$rawPipe.write(buf.subarray(written));
            written += n;
        }
    }

    get readable(): ReadableStream {
        return this.$readable;
    }

    get writable(): WritableStream {
        return this.$writable;
    }

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

    async read(p: Uint8Array): Promise<number | null> {
        const buf = this.$pipe.read(p.byteLength);
        if (buf === null) return null;
        p.set(new Uint8Array(buf));
        return buf.byteLength;
    }

    async write(p: Uint8Array): Promise<number> {
        const r = this.$pipe.write(p);
        await this.output();
        return r;
    }

    closeWrite(): Promise<void> {
        return this.$rawPipe.shutdown();
    }

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
    constructor(
        protected $pipe: CModuleStreams.Stream,
        protected $isTCP: boolean,
        protected $addr: Deno.Addr
    ) {

    }

    async accept(): Promise<Deno.Conn<Deno.Addr>> {
        const conn = await this.$pipe.accept();
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

    async *[Symbol.asyncIterator]() {
        while (true) {
            const conn = await this.accept();
            yield conn;
        }
    }

    [Symbol.dispose]() {
        return this.close();
    }
}

function toConn(sslpipe: CModuleSSL.Pipe, pipe: CModuleStreams.TCP): Deno.TlsConn {
    // feed data until EOF
    let handshake = false;
    const hsProm = Promise.withResolvers<Deno.TlsHandshakeInfo>();
    (async () => {
        const buf = new Uint8Array(2048);
        while (true) {
            const n = await pipe.read(buf);
            if (n === null) break;
            sslpipe.feed(buf.subarray(0, n));
            if (!handshake && sslpipe.doHandshake()) {
                handshake = true;
                hsProm.resolve({
                    alpnProtocol: sslpipe.getALPNProtocol()
                });
            }
        }
    })();

    // then, give to TlsConn
    return new TlsConn(sslpipe, pipe, hsProm.promise);
}

class TcpListener extends Listener implements Deno.TcpListener {
    get addr(): Deno.NetAddr {
        return this.$addr as Deno.NetAddr;
    }

    accept(): Promise<Deno.TcpConn> {
        return super.accept() as Promise<Deno.TcpConn>;
    }

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

    async accept(): Promise<Deno.TlsConn> {
        const conn = await this.$pipe.accept();

        // create SSLPipe
        const sslpipe = new ssl.Pipe(this.sslCtx, {
            servername: (this.$addr as Deno.NetAddr).hostname
        });
        return toConn(sslpipe, conn as CModuleStreams.TCP);
    }

    async* [Symbol.asyncIterator](){
        while (true) {
            const conn = await this.accept();
            yield conn;
        }
    }

    get addr(): Deno.NetAddr {
        return this.$addr as Deno.NetAddr;
    }
}

Object.assign(Deno, {
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
                return info.filter(i => i.type == dns[type]).map(i => i.name);
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
            case 'tcp':
                const host = options.hostname ?? '::';
                const tcp = new stream.TCP(host.includes(':') ? os.AF_INET6 : os.AF_INET);
                const dnsanswer = await dns.resolve(host, { family: host.includes(':') ? 6 : 4 });
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
        await pipe.connect({ ip: options.hostname ?? '::', port: options.port });

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
            case 'tcp':
                const isV4 = !opt.hostname?.includes(':');
                const tcp = new stream.TCP(isV4 ? os.AF_INET : os.AF_INET6);
                tcp.bind({
                    ip: opt.hostname ?? '::',
                    port: opt.port
                })
                tcp.listen(opt.tcpBacklog);
                return new TcpListener(tcp, true, {
                    hostname: opt.hostname ?? '::',
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
            ip: opt.hostname ?? '::',
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
            hostname: opt.hostname ?? '::',
            port: opt.port,
            transport: 'tcp'
        }, ctx);
        return listener;
    },

    async startTls(conn, opt){
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
} satisfies Partial<typeof Deno>);