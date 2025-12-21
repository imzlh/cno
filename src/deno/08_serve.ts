/**
 * Deno.serve API 实现
 * 基于之前实现的 HTTP Server 和 WebSocket
 */

import { createServer, Server, ServerRequest, ServerResponse } from '../module/http/server';
import { WebSocket } from '../module/http/websocket';

const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');

/**
 * WebSocket 升级标记
 */
const websocketSymbol = Symbol('server.websocket');

/**
 * 扩展的 Response 接口（用于 WebSocket）
 */
interface WebSocketResponse extends Response {
    [websocketSymbol]?: (req: ServerRequest, res: ServerResponse) => Promise<void>;
}

/**
 * Serve 连接信息
 */
interface ServeConnInfo {
    readonly remoteAddr: Deno.NetAddr | Deno.UnixAddr;
    readonly completed: Promise<void>;
}

/**
 * HTTP 服务器包装
 */
class HttpServer implements Deno.HttpServer<Deno.NetAddr> {
    private server: Server;
    private $finished: boolean = false;
    readonly addr: Deno.NetAddr;

    constructor(server: Server, addr: Deno.NetAddr) {
        this.server = server;
        this.addr = addr;
    }

    get finished(): Promise<void> {
        return new Promise((resolve) => {
            if (this.$finished) {
                resolve();
            } else {

                const checkInterval = setInterval(() => {
                    if (this.$finished) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
            }
        });
    }

    ref(): void {
        // NOOP
    }

    unref(): void {
        // NOOP
    }

    shutdown(): Promise<void> {
        this.$finished = true;
        this.server.close();
        return Promise.resolve();
    }

    [Symbol.asyncDispose](): Promise<void> {
        return this.shutdown();
    }
}

/**
 * 创建 Request 对象
 */
function createRequest(req: ServerRequest): Request {
    const url = new URL(req.url, `http://${req.headers.get('host') || 'localhost'}`);

    return new Request(url.toString(), {
        method: req.method,
        headers: req.headers as any,
        body: req.body as any
    });
}

/**
 * 创建连接信息
 */
function createConnInfo(req: ServerRequest, completed: Promise<void>): ServeConnInfo {

    const addr = req.socket._getConnection().socket.getpeername();

    return {
        remoteAddr: {
            hostname: addr.ip,
            port: addr.port,
            transport: 'tcp' as const
        },
        completed
    };
}

/**
 * 处理 Response 并发送
 */
async function handleResponse(
    response: Response,
    req: ServerRequest,
    res: ServerResponse
): Promise<void> {

    const wsResponse = response as WebSocketResponse;
    if (wsResponse[websocketSymbol]) {
        await wsResponse[websocketSymbol]!(req, res);
        return;
    }


    res.status(response.status, response.statusText);


    response.headers.forEach((value, key) => {
        res.setHeader(key, value);
    });


    await res.writeHead();


    if (response.body) {
        const reader = response.body.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                await res.write(value);
            }
        } finally {
            reader.releaseLock();
        }
    }


    await res.end();
}

/**
 * TCP 服务器
 */
async function serveTcp(
    options: Deno.ServeTcpOptions & Deno.ServeInit<Deno.NetAddr>
): Promise<Deno.HttpServer<Deno.NetAddr>> {
    const server = createServer(async (req, res) => {
        try {

            const completedResolvers = Promise.withResolvers<void>();
            const request = createRequest(req);
            const connInfo = createConnInfo(req, completedResolvers.promise);
            // @ts-ignore UnixAddr never reaches here
            const response = await options.handler(request, connInfo);

            await handleResponse(response, req, res);

            completedResolvers.resolve();

        } catch (error) {
            console.error('Request handler error:', error);


            try {
                if (!res['headersSent']) {
                    await res.status(500).text('Internal Server Error');
                }
            } catch (e) {

            }
        }
    });


    const hostname = options.hostname || '0.0.0.0';
    const port = options.port || 8000;

    server.listen(port, hostname, {
        keepAliveTimeout: 5000,
        maxRequestsPerConnection: 1000
    });

    console.log(`HTTP server listening on http://${hostname}:${port}`);

    return new HttpServer(server, {
        transport: 'tcp',
        hostname,
        port
    });
}

/**
 * TLS 服务器
 */
async function serveTls(
    options: Deno.ServeTcpOptions & Deno.ServeInit<Deno.NetAddr> & Deno.TlsCertifiedKeyPem
): Promise<Deno.HttpServer<Deno.NetAddr>> {

    if (!options.cert || !options.key) {
        throw new TypeError('TLS options must include cert and key');
    }


    let certPath: string;
    let keyPath: string;

    if (typeof options.cert === 'string') {

        certPath = options.cert;
    } else {

        const tmpCert = `/tmp/cert-${Date.now()}.pem`;
        const certContent = typeof options.cert === 'string'
            ? options.cert
            : engine.decodeString(options.cert);
        await Deno.writeTextFile(tmpCert, certContent);
        certPath = tmpCert;
    }

    if (typeof options.key === 'string') {
        keyPath = options.key;
    } else {
        const tmpKey = `/tmp/key-${Date.now()}.pem`;
        const keyContent = typeof options.key === 'string'
            ? options.key
            : engine.decodeString(options.key);
        await Deno.writeTextFile(tmpKey, keyContent);
        keyPath = tmpKey;
    }

    const server = createServer(async (req, res) => {
        try {
            const completedResolvers = Promise.withResolvers<void>();
            const request = createRequest(req);
            const connInfo = createConnInfo(req, completedResolvers.promise);
            // @ts-ignore UnixAddr never reaches here
            const response = await options.handler(request, connInfo);
            await handleResponse(response, req, res);

            completedResolvers.resolve();

        } catch (error) {
            console.error('Request handler error:', error);

            try {
                if (!res['headersSent']) {
                    await res.status(500).text('Internal Server Error');
                }
            } catch (e) {

            }
        }
    });

    const hostname = options.hostname || '0.0.0.0';
    const port = options.port || 8443;

    server.listenTLS(port, hostname, {
        cert: certPath,
        key: keyPath,
        keepAliveTimeout: 5000,
        maxRequestsPerConnection: 1000
    });

    console.log(`HTTPS server listening on https://${hostname}:${port}`);

    return new HttpServer(server, {
        transport: 'tcp',
        hostname,
        port
    });
}

/**
 * Unix Socket 服务器
 */
async function serveUnix(
    options: Deno.ServeUnixOptions & Deno.ServeInit<Deno.UnixAddr>
): Promise<Deno.HttpServer<Deno.UnixAddr>> {
    throw new Deno.errors.NotSupported('Unix socket server not yet implemented');
}

/**
 * Deno.serve 实现
 */
function serve(options: Deno.ServeOptions): Deno.HttpServer;
function serve(handler: Deno.ServeHandler): Deno.HttpServer;
function serve(
    options: Deno.ServeOptions,
    handler: Deno.ServeHandler
): Deno.HttpServer;
function serve(
    optionsOrHandler: Deno.ServeOptions | Deno.ServeHandler,
    handler?: Deno.ServeHandler
): Deno.HttpServer {
    let options: Deno.ServeOptions;

    if (typeof optionsOrHandler === 'function') {
        options = {
            // @ts-ignore
            handler: optionsOrHandler,
            port: 8000
        };
    } else {
        options = optionsOrHandler;
        if (handler) {
            // @ts-ignore
            options.handler = handler;
        }
    }

    // @ts-ignore
    if (!options.handler) {
        throw new TypeError('Handler is required');
    }


    if ('path' in options && options.path) {

        return serveUnix(options as any) as any;
    } else if ('cert' in options && 'key' in options) {

        return serveTls(options as any) as any;
    } else {

        return serveTcp(options as any) as any;
    }
}

/**
 * 计算 WebSocket Accept 值
 */
function calculateWebSocketAccept(key: string): string {
    const magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const hash = crypto.sha1(engine.encodeString(key + magic));
    return crypto.base64Encode(hash);
}

/**
 * Deno.upgradeWebSocket 实现
 */
function upgradeWebSocket(
    request: Request,
    options?: Deno.UpgradeWebSocketOptions
): Deno.WebSocketUpgrade {

    const upgradeHeader = request.headers.get('upgrade')?.toLowerCase();
    const connectionHeader = request.headers.get('connection')?.toLowerCase();
    const wsKey = request.headers.get('sec-websocket-key');
    const wsVersion = request.headers.get('sec-websocket-version');

    if (upgradeHeader !== 'websocket' || !connectionHeader?.includes('upgrade')) {
        throw new TypeError('Not a WebSocket upgrade request');
    }

    if (wsVersion !== '13') {
        throw new TypeError('Unsupported WebSocket version');
    }

    if (!wsKey) {
        throw new TypeError('Missing Sec-WebSocket-Key header');
    }


    const headers = new Headers({
        'upgrade': 'websocket',
        'connection': 'Upgrade',
        'sec-websocket-accept': calculateWebSocketAccept(wsKey)
    });


    const protocols = request.headers.get('sec-websocket-protocol');
    if (protocols && options?.protocol) {
        const requestedProtocols = protocols.split(',').map(p => p.trim());
        if (requestedProtocols.includes(options.protocol)) {
            headers.set('sec-websocket-protocol', options.protocol);
        }
    }


    let wsResolve: (ws: WebSocket) => void;
    const wsPromise = new Promise<WebSocket>((resolve) => {
        wsResolve = resolve;
    });


    const response = new Response(null, {
        status: 101,
        statusText: 'Switching Protocols',
        headers
    }) as WebSocketResponse;

    // @ts-ignore internal symbol
    response[websocketSymbol] = async (req: ServerRequest, res: ServerResponse) => {
        const ws = await res.upgrade();
        queueMicrotask(() => {
            wsResolve(ws);

            try {
                ws.onopen?.(new Event('open'));
                ws.dispatchEvent(new Event('open'));
            } catch (err) {
                console.error('WebSocket onopen error:', err);
            }
        });
    };

    return {
        response,
        socket: wsPromise as any
    };
}

Object.assign(Deno, {
    serve,
    upgradeWebSocket
});