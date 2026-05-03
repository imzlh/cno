/**
 * CNO example - 使用CNO实现终端服务
 */

/// <reference path="../../src/type/lib.cno.d.ts" />

import { load as loadEnv } from "jsr:@std/dotenv";
import { join, normalize } from "jsr:@std/path";
import { contentType } from "jsr:@std/media-types";

globalThis.addEventListener('error', e => {
    console.error(e.error);
});

// ============================================================================
// 配置管理
// ============================================================================

interface ServerConfig {
    port: number;
    hostname: string;
    wsPath: string;
    allowedExts: Set<string>;
    staticDir: string;
    pty: {
        shell: string;
        cols: number;
        rows: number;
        term: string;
    };
}

const DEFAULT_CONFIG: ServerConfig = {
    port: 8080,
    hostname: "::",
    wsPath: "/ws",
    allowedExts: new Set([
        "html", "css", "js", "json", "ico", "svg", "png", "webp", "jpg", "jpeg"
    ]),
    staticDir: Deno.cwd(),
    pty: {
        shell: Deno.env.get("SHELL") || "/bin/bash",
        cols: 80,
        rows: 24,
        term: "xterm-256color",
    },
};

function loadConfig(): Promise<ServerConfig> {
    return loadEnv().then((env) => ({
        port: Number(env.PORT) || DEFAULT_CONFIG.port,
        hostname: env.HOSTNAME || DEFAULT_CONFIG.hostname,
        wsPath: env.WS_PATH || DEFAULT_CONFIG.wsPath,
        allowedExts: DEFAULT_CONFIG.allowedExts,
        staticDir: env.STATIC_DIR || DEFAULT_CONFIG.staticDir,
        pty: {
            shell: env.SHELL || DEFAULT_CONFIG.pty.shell,
            cols: Number(env.PTY_COLS) || DEFAULT_CONFIG.pty.cols,
            rows: Number(env.PTY_ROWS) || DEFAULT_CONFIG.pty.rows,
            term: env.TERM || DEFAULT_CONFIG.pty.term,
        },
    })).catch(() => DEFAULT_CONFIG);
}

// ============================================================================
// 类型定义
// ============================================================================

interface ResizeCommand {
    row: number;
    col: number;
}
interface WebSocketMessageEvent extends Event {
    data: string | ArrayBuffer;
}

// ============================================================================
// PTY WebSocket 处理器
// ============================================================================

class PtyWebSocketHandler {
    private pty: CNO.PtyPipe | null = null;
    private abortController = new AbortController();

    constructor(
        private socket: WebSocket,
        private config: ServerConfig
    ) { }

    async handle(): Promise<void> {
        this.socket.onopen = () => this.onOpen().catch(this.onError);
        this.socket.onclose = () => this.onClose();
        this.socket.onerror = (event) => this.onError(event);
    }

    private async onOpen(): Promise<void> {
        console.info("WebSocket connection established");
        try {
            // 创建 PTY
            this.pty = await CNO.openpty({
                argv: [this.config.pty.shell],
                env: {
                    ...Deno.env.toObject(),
                    TERM: this.config.pty.term,
                    COLORTERM: "truecolor",
                },
                cwd: this.config.staticDir,
                cols: this.config.pty.cols,
                rows: this.config.pty.rows,
            });
            this.socket.send(new TextEncoder().encode(`\x1b[32mWelcome to CNO terminal\r\n\x1b[0m\x1b[33mrunning ${this.config.pty.shell}\x1b[0m\r\n`));

            // 启动 PTY 输出 -> WebSocket 的流式传输
            this.startPtyToWebSocket();

            // 处理 WebSocket 输入 -> PTY
            this.socket.onmessage = (event) => this.onMessage(event).catch(this.onError);

            console.info(`PTY started with shell: ${this.config.pty.shell}`);
        } catch (error) {
            console.error(`Failed to create PTY: ${error}`);
            this.socket.close(1011, "Internal server error");
        }
    }

    private async onMessage(event: WebSocketMessageEvent): Promise<void> {
        if (!this.pty) {
            console.error("Received message before PTY initialized");
            return;
        }

        const writer = this.pty.writable.getWriter();

        try {
            if (typeof event.data === "string") {
                // 文本帧：resize 命令
                const cmd: Partial<ResizeCommand> = JSON.parse(event.data);
                if (Number.isInteger(cmd.row) && Number.isInteger(cmd.col)) {
                    this.pty.resize(cmd.col!, cmd.row!);
                    console.debug(`Terminal resized to ${cmd.col}x${cmd.row}`);
                } else {
                    throw new Error("Invalid resize command");
                }
            } else if (event.data instanceof ArrayBuffer) {
                // 二进制帧：终端输入
                await writer.write(new Uint8Array(event.data));
            }
        } finally {
            writer.releaseLock();
        }
    }

    private startPtyToWebSocket(): void {
        if (!this.pty) return;

        const reader = this.pty.readable.getReader();
        const { signal } = this.abortController;

        (async () => {
            try {
                while (!signal.aborted) {
                    const { done, value } = await Promise.race([
                        reader.read(),
                        this.abortSignalPromise(signal),
                    ]);

                    if (done || signal.aborted) break;

                    if (this.socket.readyState === WebSocket.OPEN) {
                        try {
                            await this.socket.send(value);
                        } catch (error) {
                            console.error(`WebSocket send failed: ${error}`);
                            break;
                        }
                    }
                }
            } catch (error) {
                console.error(`PTY read error: ${error}`);
            } finally {
                reader.releaseLock();
                this.close();
            }
        })();
    }

    private onClose(): void {
        console.info("WebSocket connection closed");
        this.close();
    }

    private onError = (error: unknown): void => {
        console.error(`WebSocket error: ${error}`);
    };

    private close(): void {
        this.abortController.abort();

        if (this.pty) {
            this.pty.kill("SIGTERM");
            this.pty = null;
        }

        if (this.socket.readyState === WebSocket.OPEN) {
            try {
                this.socket.close();
            } catch (error) {
                console.warn(`Error closing WebSocket: ${error}`);
            }
        }
    }

    private abortSignalPromise(signal: AbortSignal): Promise<never> {
        return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
                once: true,
            });
        });
    }
}

// ============================================================================
// 静态文件服务
// ============================================================================

class StaticFileServer {
    constructor(private config: ServerConfig) { }

    async serve(req: Request, url: URL): Promise<Response> {
        const pathname = url.pathname;
        const filePath = pathname === "/" ? "/index.html" : pathname;

        // 安全性：防止路径遍历
        const normalizedPath = normalize(filePath);
        if (normalizedPath.startsWith("..")) {
            console.warn(`Forbidden path traversal attempt: ${pathname}`);
            return new Response("Forbidden", { status: 403 });
        }

        const extension = filePath.split(".").pop()?.toLowerCase();
        if (!extension || !this.config.allowedExts.has(extension)) {
            console.warn(`Forbidden file type: ${extension}`);
            return new Response("Forbidden", { status: 403 });
        }

        try {
            const absolutePath = join(this.config.staticDir, normalizedPath);
            const file = await Deno.readFile(absolutePath);
            const mimeType = contentType(extension) || "application/octet-stream";

            return new Response(file, {
                status: 200,
                headers: {
                    "Content-Type": mimeType,
                    "Cache-Control": "public, max-age=3600",
                    "X-Content-Type-Options": "nosniff",
                    "Content-Length": file.byteLength.toString(),
                },
            });
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
                console.warn(`File not found: ${normalizedPath}`);
                return new Response("Not Found", { status: 404 });
            }

            console.error(`Error serving file: ${error}`);
            return new Response("Internal Server Error", { status: 500 });
        }
    }
}

// ============================================================================
// 主服务器
// ============================================================================

class WebTerminalServer {
    private config: ServerConfig;
    private ptyHandler: typeof PtyWebSocketHandler;
    private fileServer: StaticFileServer;

    constructor(config: ServerConfig) {
        this.config = config;
        this.ptyHandler = PtyWebSocketHandler;
        this.fileServer = new StaticFileServer(config);
    }

    async handleRequest(req: Request): Promise<Response> {
        const url = new URL(req.url);
        console.log(req.method, new URL(req.url).pathname);

        // WebSocket 终端连接
        if (url.pathname === this.config.wsPath) {
            return this.handleWebSocketUpgrade(req);
        }

        // 静态文件服务
        return this.fileServer.serve(req, url);
    }

    private handleWebSocketUpgrade(req: Request): Response {
        console.info(`WebSocket upgrade request from ${req.headers.get("origin") || "unknown"}`);

        const { socket, response } = Deno.upgradeWebSocket(req, {
            idleTimeout: 300, // 5 分钟空闲超时
        });

        const handler = new this.ptyHandler(socket, this.config);
        handler.handle().catch((error) => {
            console.error(`WebSocket handler error: ${error}`);
        });

        return response;
    }

    start(): void {
        const options = { port: this.config.port, hostname: this.config.hostname };
        Deno.serve(options, (req) => this.handleRequest(req));

        console.log(`Web Terminal Server running at http://127.0.0.1:${options.port}`);
    }
}

// ============================================================================
// 启动
// ============================================================================

(async () => {
    try {
        const config = await loadConfig();
        const server = new WebTerminalServer(config);
        server.start();
    } catch (error) {
        console.error(`Failed to start server: ${error}`);
        console.error(error);
        Deno.exit(1);
    }
})();