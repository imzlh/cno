/**
 * ServerConnection — HTTP/1.1 parsing and response layer (server side)
 * Extends TcpSocket for SSL-aware I/O; does NOT duplicate read/write logic.
 *
 * Responsibilities:
 * - HTTP/1.1 request parsing via llhttp
 * - Streaming request body (ReadableStream)
 * - HTTP response writing (writeHead / write / end)
 * - WebSocket upgrade handoff
 * - Keep-alive tracking
 */

import { assert } from "../../utils/assert";
import { wrapFsClassDec as wrap } from "../../utils/wrap";
import { TcpSocket } from "./socket";
import type { Server } from "./server";

const http   = import.meta.use("http");
const engine = import.meta.use("engine");
const error  = import.meta.use("error");

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/* ------------------------------------------------------------------ */
/* Public types (re-exported so server.ts stays thin)                 */
/* ------------------------------------------------------------------ */

export interface HttpRequest {
    method:      string;
    url:         string;
    httpVersion: string;
    headers:     Map<string, string>;
    body:        ReadableStream<Uint8Array> | null;
}

export interface HttpResponse {
    writeHead(status: number, statusText: string, headers: Record<string, string>): Promise<void>;
    write(chunk: Uint8Array | string): Promise<void>;
    end(chunk?: Uint8Array | string): Promise<void>;
    /** Upgrade to WebSocket — returns the underlying connection for raw I/O */
    upgrade(): ServerConnection;
    close(): void;
}

export type RequestHandler = (req: HttpRequest, res: HttpResponse) => void | Promise<void>;

/* ------------------------------------------------------------------ */
/* Internal state enum                                                */
/* ------------------------------------------------------------------ */

const enum State {
    IDLE       = "idle",
    PARSING    = "parsing",
    RESPONDING = "responding",
    UPGRADING  = "upgrading",
    UPGRADED   = "upgraded",
    CLOSED     = "closed",
}

// llhttp method enum → string
const HTTP_METHODS = [
    "DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT",
    "OPTIONS", "TRACE", "COPY", "LOCK", "MKCOL", "MOVE",
    "PROPFIND", "PROPPATCH", "SEARCH", "UNLOCK", "BIND",
    "REBIND", "UNBIND", "ACL", "REPORT", "MKACTIVITY",
    "CHECKOUT", "MERGE", "MSEARCH", "NOTIFY", "SUBSCRIBE",
    "UNSUBSCRIBE", "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK"
] as const;

/* ------------------------------------------------------------------ */
/* ServerConnection                                                   */
/* ------------------------------------------------------------------ */

export class ServerConnection extends TcpSocket {
    private state:  State  = State.IDLE;
    private server: Server;
    private parser: CModuleHTTP.Parser;

    // Per-request parse state
    private method        = "";
    private url           = "";
    private headers       = new Map<string, string>();
    private headerField   = "";
    private headersOk     = false;
    private expectBody    = false;
    private contentLength = 0;
    private chunked       = false;
    private bodyRead      = 0;
    private bodyCtrl:  ReadableStreamDefaultController<Uint8Array> | null = null;

    // Per-request response state
    private headersSent    = false;
    private responseEnded  = false;
    private chunkedEncoding = false;

    // Keep-alive
    private requestCount = 0;
    private keepAlive    = true;

    constructor(socket: CModuleStreams.TCP, server: Server) {
        super(socket);
        this.server = server;
        this.parser = new http.Parser(http.REQUEST);
        this.setupParser();
    }

    /* -------------------------------------------------------------- */
    /* Parser Setup                                                   */
    /* -------------------------------------------------------------- */

    private setupParser(): void {
        const decode = (buf: any, off: number, len: number) =>
            engine.decodeString(new Uint8Array(buf as ArrayBuffer).slice(off, off + len));

        this.parser.onUrl = (buf, off, len) => {
            this.url += decode(buf, off, len);
        };

        this.parser.onHeaderField = (buf, off, len) => {
            this.headerField = decode(buf, off, len).toLowerCase();
        };

        this.parser.onHeaderValue = (buf, off, len) => {
            if (len > 8192) throw new Error("HTTP header value too long");
            const value = decode(buf, off, len);
            const existing = this.headers.get(this.headerField);
            this.headers.set(this.headerField, existing ? `${existing}, ${value}` : value);
        };

        this.parser.onHeadersComplete = () => {
            this.method    = HTTP_METHODS[this.parser.state.method] ?? "UNKNOWN";
            this.headersOk = true;

            const conn    = this.headers.get("connection")?.toLowerCase();
            const version = `${this.parser.state.httpMajor}.${this.parser.state.httpMinor}`;
            // Bug fix: respect keepAlive per actual request/version
            this.keepAlive = version === "1.1" ? conn !== "close" : conn === "keep-alive";

            const cl = this.headers.get("content-length");
            const te = this.headers.get("transfer-encoding");
            if (cl) {
                this.contentLength = parseInt(cl);
                this.expectBody = this.contentLength > 0;
            } else if (te?.toLowerCase().includes("chunked")) {
                this.chunked    = true;
                this.expectBody = true;
            }
        };

        this.parser.onBody = (buf, off, len) => {
            if (!this.bodyCtrl) return;
            const view = new Uint8Array(buf as ArrayBuffer).slice(off, off + len);
            this.bodyCtrl.enqueue(view);
            this.bodyRead += len;
            if (!this.chunked && this.bodyRead >= this.contentLength) {
                this.bodyCtrl.close();
                this.bodyCtrl = null;
            }
        };

        this.parser.onMessageComplete = () => {
            this.bodyCtrl?.close();
            this.bodyCtrl = null;
        };
    }

    /* -------------------------------------------------------------- */
    /* Request Handling                                               */
    /* -------------------------------------------------------------- */

    /** Returns true if the connection should be kept alive for another request. */
    async handleRequest(): Promise<boolean> {
        // Reset per-request state
        this.state          = State.PARSING;
        this.method         = "";
        this.url            = "";
        this.headers        = new Map();
        this.headerField    = "";
        this.headersOk      = false;
        this.expectBody     = false;
        this.contentLength  = 0;
        this.chunked        = false;
        this.bodyRead       = 0;
        this.bodyCtrl       = null as ReadableStreamDefaultController<Uint8Array> | null;
        this.headersSent    = false;
        this.responseEnded  = false;
        this.chunkedEncoding = false;

        let destState = State.RESPONDING;
        try {
            // Parse headers
            while (!this.headersOk) {
                const data = await this.read();
                if (data === null) return false;
                if (data.length === 0) continue;

                const result = this.parser.execute(data);
                if (result.errno !== 0) {
                    if (result.name === "HPE_PAUSED_UPGRADE") {
                        destState      = State.UPGRADING;
                        this.keepAlive = false;
                        this.expectBody = false;
                        break;
                    }
                    throw new Error(`HTTP parse error: ${result.reason}`);
                }
            }

            // Build streaming body if needed
            let bodyStream: ReadableStream<Uint8Array> | null = null;
            if (this.expectBody) {
                bodyStream = new ReadableStream({
                    start: (ctrl) => { this.bodyCtrl = ctrl; },
                    pull:  async (ctrl) => {
                        try {
                            const data = await this.read();
                            if (data === null) { ctrl.close(); this.bodyCtrl = null; return; }
                            const res = this.parser.execute(data);
                            if (res.errno !== 0) { ctrl.error(new Error(`HTTP parse error: ${res.reason}`)); this.bodyCtrl = null; return; }
                            if (this.parser.state.eof) { ctrl.close(); this.bodyCtrl = null; }
                        } catch (err) {
                            ctrl.error(err);
                            this.bodyCtrl = null;
                        }
                    },
                    cancel: () => { this.bodyCtrl = null; }
                });
            }

            const req: HttpRequest = {
                method:      this.method,
                url:         this.url,
                httpVersion: `${this.parser.state.httpMajor}.${this.parser.state.httpMinor}`,
                headers:     this.headers,
                body:        bodyStream
            };

            const res: HttpResponse = {
                writeHead: this.writeHead.bind(this),
                write:     this.writeData.bind(this),
                end:       this.endResponse.bind(this),
                upgrade:   this.upgradeConnection.bind(this),
                close:     this.close.bind(this)
            };

            this.state = destState;
            await this.server.handler(req, res);

            if (!this.responseEnded && !this.isUpgraded()) {
                await this.endResponse();
            }

            // Drain any unread body so the parser is clean for next request
            this.bodyCtrl?.close();
            this.bodyCtrl = null;
            if (this.expectBody && !this.isUpgraded()) {
                try {
                    while (this.bodyRead < this.contentLength || this.chunked) {
                        const data = await this.read();
                        if (data === null) break;
                        if (data.length === 0) continue;
                        this.parser.execute(data);
                        if (this.parser.state.eof) break;
                        if (this.bodyRead > 10 * 1024 * 1024) break; // safety limit
                    }
                } catch { /* ignore drain errors */ }
            }

            this.parser.reset(http.REQUEST);
            this.requestCount++;

            return this.keepAlive &&
                this.requestCount < (this.server.config.maxRequestsPerConnection ?? 100) &&
                !this.isUpgraded();

        } catch (err: any) {
            // if (!TcpSocket.isDisconnectError(err)) {
                console.error("Request handling error:", err);
            // }
            if (!this.headersSent && !this.isClosed()) {
                try {
                    await this.writeHead(500, "Internal Server Error", {});
                    await this.endResponse();
                } catch { /* ignore */ }
            }
            return false;
        }
    }

    /* -------------------------------------------------------------- */
    /* Response                                                       */
    /* -------------------------------------------------------------- */

    @wrap
    private async writeHead(status: number, statusText: string, headers: Record<string, string>): Promise<void> {
        if (this.headersSent) throw new Error("Headers already sent");

        const te = headers["transfer-encoding"];
        if (typeof te === "string" && te.toLowerCase().includes("chunked")) {
            this.chunkedEncoding = true;
        }

        // Bug fix: respect keepAlive when injecting Connection header
        let raw = `HTTP/1.1 ${status} ${statusText}\r\n`;
        if (!headers["connection"]) {
            raw += this.keepAlive ? "Connection: keep-alive\r\n" : "Connection: close\r\n";
        }
        for (const [k, v] of Object.entries(headers)) {
            const title = k.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("-");
            raw += `${title}: ${v}\r\n`;
        }
        raw += "\r\n";

        await this.write(engine.encodeString(raw));
        this.headersSent = true;
    }

    @wrap
    private async writeData(chunk: Uint8Array | string): Promise<void> {
        if (this.responseEnded) throw new Error("Response already ended");

        if (!this.headersSent) {
            this.chunkedEncoding = true;
            await this.writeHead(200, "OK", { "transfer-encoding": "chunked" });
        }

        const data = typeof chunk === "string" ? engine.encodeString(chunk) : chunk;

        if (this.chunkedEncoding) {
            await this.write(engine.encodeString(data.length.toString(16) + "\r\n"));
            await this.write(data);
            await this.write(engine.encodeString("\r\n"));
        } else {
            await this.write(data);
        }
    }

    @wrap
    private async endResponse(chunk?: Uint8Array | string): Promise<void> {
        if (this.responseEnded) return;

        if (chunk !== undefined) {
            await this.writeData(chunk);
        } else if (!this.headersSent) {
            await this.writeHead(200, "OK", { "content-length": "0" });
        }

        if (this.chunkedEncoding) {
            await this.write(engine.encodeString("0\r\n\r\n"));
            this.chunkedEncoding = false;
        }

        this.responseEnded = true;
        this.state         = State.IDLE;
    }

    private upgradeConnection(): ServerConnection {
        // Bug fix: was assert(this.headersSent, ...) — inverted
        assert(!this.headersSent,                      "Cannot upgrade after headers sent");
        assert(this.state === State.UPGRADING,         "Cannot upgrade a non-upgrading connection");

        this.state     = State.UPGRADED;
        this.keepAlive = false;
        return this;
    }

    /* -------------------------------------------------------------- */
    /* State                                                          */
    /* -------------------------------------------------------------- */

    isUpgraded(): boolean { return this.state === State.UPGRADED; }
    isClosed():   boolean { return this.state === State.CLOSED;   }

    close(): void {
        if (this.state === State.CLOSED) return;
        this.state = State.CLOSED;

        this.bodyCtrl?.close();
        this.bodyCtrl = null;

        super.close();
    }
}
