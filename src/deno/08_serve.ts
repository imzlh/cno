import WebSocket from "../webapi/ws";

const server = import.meta.use('server');
const ssl = import.meta.use('ssl');
const asfs = import.meta.use('asyncfs');
const crypto = import.meta.use('crypto');
const stream = import.meta.use('streams');

const websocketSymbol = Symbol('server.websocket');

interface Response extends globalThis.Response {
    [websocketSymbol]: (res: CModuleServer.HttpResponse) => void;
}

function createRequest(req: CModuleServer.HttpRequest, res: CModuleServer.HttpResponse): Request {
    return new Request(req.url, {
        body: req.body ?? null,
        headers: req.headers,
        method: req.method
    });
}

async function handleHandler(
    handler: Response | Promise<Response>,
    end: PromiseWithResolvers<void>,
    req: CModuleServer.HttpRequest,
    res: CModuleServer.HttpResponse
) {
    try {
        const response = await handler;
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

        if (response[websocketSymbol]) {
            response[websocketSymbol](res); // then, ws onopen() triggered
        } else {
            if (response.body) {
                const reader = response.body.getReader();
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    res.write(value.buffer);
                }
            }
        }
        end.resolve();
    } catch (e) {
        console.error(e);
        res.send(500, "Internal Server Error");
        end.resolve();
    }
}

function serveUnix(addr: Deno.ServeUnixOptions & Deno.ServeInit<Deno.UnixAddr>) {
    throw new Error('Not implemented');
}
function serveTcp(addr: Deno.ServeTcpOptions & Deno.ServeInit<Deno.NetAddr>) {
    return server.createServer({
        address: addr.hostname ?? '::',
        port: addr.port ?? 80,
        onRequest() { },
        onComplete(req, res, info) {
            const request = createRequest(req, res);
            const end = Promise.withResolvers<void>();
            // @ts-ignore cast Response
            handleHandler(addr.handler(request, {
                completed: end.promise,
                remoteAddr: {
                    hostname: info.address,
                    port: info.port,
                    transport: 'tcp'
                }
            }), end, req, res);
        },
    })
}
async function serveTls(addr: Deno.TlsCertifiedKeyPem & Deno.ServeTcpOptions & Deno.ServeInit<Deno.NetAddr>) {
    if (addr.keyFormat && addr.keyFormat != 'pem')
        throw new Error('Unsupported key format');
    const cert = new ssl.Context({
        mode: 'server',
        cert: await Deno.readTextFile(addr.cert),
        key: await Deno.readTextFile(addr.key)
    });

    return server.createServer({
        address: addr.hostname ?? '::',
        port: addr.port ?? 80,
        onAccept(info) {
            // allow user to determine which client certificates to accept?
            return cert;
        },

        onRequest() { },
        onComplete(req, res, info) {
            const request = createRequest(req, res);
            const end = Promise.withResolvers<void>();
            // @ts-ignore cast Response
            handleHandler(addr.handler(request, {
                completed: end.promise,
                remoteAddr: {
                    hostname: info.address,
                    port: info.port,
                    transport: 'tcp'
                }
            }), end, req, res);
        },
    })
}

function calcWsAccept(key: string) {
    const joint = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    return crypto.base64Encode(crypto.sha1(new TextEncoder().encode(joint)));
}

Object.assign(Deno, {
    // @ts-ignore
    async serve(opt, opt2) {
        if (!server) throw new Error('circu.js server is not built in binary.');
        if (typeof opt == 'function') {
            this.serve!({
                ...opt2,
                handler: opt
            })
        } else switch (opt.transport) {
            case 'unix':
                return serveUnix(opt as any);

            case 'tcp':
                if ('cert' in opt && 'key' in opt)
                    return serveTls(opt as any);
                else
                    return serveTcp(opt as any);

            case 'vsock':
                throw new Deno.errors.NotSupported();

            default:
                throw new Error(`Unsupported transport: ${opt.transport}`);
        }
    },

    upgradeWebSocket(req, opt) {
        const wskey = req.headers.get('sec-websocket-key');
        if (!wskey) throw new Error('Not a WebSocket request.');

        const response = new Response(null, {
            status: 101,
            statusText: 'Switching Protocols',
            headers: new Headers({
                'upgrade': 'websocket',
                'connection': 'upgrade',
                'sec-websocket-accept': calcWsAccept(wskey),
            })
        });
        const prom = new Promise<CModuleStreams.Pipe>(rs => {
            // @ts-ignore
            response[websocketSymbol] = (res: CModuleServer.HttpResponse) => {
                const fd = res.upgrade();
                const pipe = new stream.Pipe();
                pipe.open(fd);
                rs(pipe);
            }
        });
        const socket = WebSocket.createWebSocketFromPipe(prom, req.url);

        return {
            response,
            socket
        }
    }
} satisfies Partial<typeof Deno>);