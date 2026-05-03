/**
 * Shared TCP/SSL socket I/O base
 * Used by both client (Connection) and server (ServerConnection)
 * 
 * Handles:
 * - Plaintext and SSL read/write
 * - SSL BIO partial-feed (pendingCiphertext)
 * - TLS handshake loop (both client and server side)
 */

import { wrapFsClassDec as wrap } from "../../utils/wrap";

const streams = import.meta.use("streams");
const ssl     = import.meta.use("ssl");
const error   = import.meta.use("error");
const engine = import.meta.use("engine");

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

const READ_SIZE = 16384;

export class TcpSocket {
    public  socket:  CModuleStreams.TCP;
    public  sslPipe: CModuleSSL.Pipe | null = null;
    private pending: Uint8Array | null = null;  // partial ciphertext not yet fed to SSL

    constructor(socket?: CModuleStreams.TCP) {
        this.socket = socket ?? new streams.TCP();
    }

    private _readCallback: ((data: Uint8Array | null) => void) | null = null;
    private _readErrHandler: ((err: Error) => void) | null = null;

    private setupReadCallback(): void {
        // Stop any previous read mode (e.g. promise-based TcpSocket.read())
        // before switching to callback-based onread mode.
        try { this.socket.stopRead(); } catch { /* ignore */ }
        // @ts-ignore - onread is not in type definition but exists at runtime
        this.socket.onread = (data: Uint8Array | null | undefined, err?: CModuleError.Error) => {
            if (data === undefined) {
                if (err) {
                    this._readErrHandler?.(err);
                    // @ts-ignore
                    this.socket.onread = null;
                }
                return;
            }
            if (data === null) {
                this._readCallback?.(null);
                return;
            }
            this._readCallback?.(data);
            if (this._readCallback) {
                try {
                    this.socket.startRead();
                } catch (e: any) {
                    if (e.code !== 'EALREADY') throw e;
                }
            }
        };
        try {
            this.socket.startRead();
        } catch (e: any) {
            if (e.code !== 'EALREADY') throw e;
        }
    }

    onReadable(callback: (data: Uint8Array | null) => void, errHandler?: (err: Error) => void): void {
        this._readCallback = callback;
        this._readErrHandler = errHandler ?? null;
        this.setupReadCallback();
    }

    stopReading(): void {
        this.socket.stopRead();
        this._readCallback = null;
        this._readErrHandler = null;
        // @ts-ignore
        this.socket.onread = null;
    }

    /* -------------------------------------------------------------- */
    /* Read / Write                                                   */
    /* -------------------------------------------------------------- */

    /**
     * Read plaintext from socket (SSL-aware).
     * Returns null on EOF.
     */
    @wrap
    async read(size = READ_SIZE): Promise<Uint8Array | null> {
        if (!this.sslPipe) {
            const buf = new Uint8Array(size);
            const n = await this.socket.read(buf);
            return (n === 0) ? null : buf.subarray(0, n);
        }

        const buffered = this.sslRead(size);
        if (buffered) return buffered;

        if (this.pending) {
            const plain = this.feedAndRead(this.pending, size);
            this.pending = null;
            if (plain) return plain;
        }

        const buf = new Uint8Array(size);
        const n = await this.socket.read(buf);
        if (n === 0) return null;

        const cipher = buf.subarray(0, n);
        const consumed = this.feedCipher(cipher);
        if (consumed < cipher.length) {
            this.pending = cipher.subarray(consumed);
        }

        return this.sslRead(size);
    }

    /**
     * Write plaintext to socket (SSL-aware).
     */
    @wrap
    async write(data: Uint8Array): Promise<void> {
        if (data.length === 0) return;

        if (!this.sslPipe) {
            await this.socket.write(data);
            return;
        }

        let offset = 0;
        while (offset < data.length) {
            const written = this.sslPipe.write(data.subarray(offset));
            if (written < 0) throw new Error(`SSL_write failed: ${written}`);
            offset += written;
        }

        const encrypted = this.sslPipe.getOutput();
        if (encrypted) await this.socket.write(new Uint8Array(encrypted));
    }

    /* -------------------------------------------------------------- */
    /* TLS Handshake                                                  */
    /* -------------------------------------------------------------- */

    /**
     * Server-side TLS handshake.
     * Creates the SSL pipe from the given context and completes the handshake.
     */
    @wrap
    async serverHandshake(ctx: CModuleSSL.Context): Promise<void> {
        this.sslPipe = new ssl.Pipe(ctx);
        const buf = new Uint8Array(READ_SIZE);

        while (!this.sslPipe.handshakeComplete) {
            const n = await this.socket.read(buf);
            if (n === 0) throw new Error("SSL handshake failed: connection closed");

            let toFeed = buf.subarray(0, n);
            while (toFeed.length > 0) {
                const c = this.feedCipher(toFeed);
                if (c <= 0) break;
                toFeed = toFeed.subarray(c);
            }

            this.sslPipe.handshake();
            const out = this.sslPipe.getOutput();
            if (out) await this.socket.write(new Uint8Array(out));
        }
    }

    /**
     * Client-side TLS handshake.
     * Sends ClientHello and loops until handshake is complete.
     */
    @wrap
    async clientHandshake(ctx: CModuleSSL.Context, servername?: string): Promise<void> {
        this.sslPipe = new ssl.Pipe(ctx, servername ? { servername } : undefined);
        this.sslPipe.handshake();  // generate ClientHello

        const initial = this.sslPipe.getOutput();
        if (initial) await this.socket.write(new Uint8Array(initial));

        const buf = new Uint8Array(READ_SIZE);
        while (!this.sslPipe.handshakeComplete) {
            const n = await this.socket.read(buf);
            if (n === 0) throw new Error("TLS handshake failed: connection closed");

            let toFeed = buf.subarray(0, n);
            while (toFeed.length > 0) {
                const c = this.feedCipher(toFeed);
                if (c <= 0) throw new Error(`SSL feed failed during handshake: consumed=${c}`);
                toFeed = c < toFeed.length ? toFeed.subarray(c) : new Uint8Array(0);
            }

            this.sslPipe.handshake();
            const out = this.sslPipe.getOutput();
            if (out) await this.socket.write(new Uint8Array(out));
        }
    }

    /* -------------------------------------------------------------- */
    /* Close                                                          */
    /* -------------------------------------------------------------- */

    close(): void {
        this.pending = null;
        this.stopReading();
        try { this.sslPipe?.shutdown(); } catch { /* ignore */ }
        try { this.socket.close();      } catch { /* ignore */ }
    }

    /* -------------------------------------------------------------- */
    /* Helpers                                                        */
    /* -------------------------------------------------------------- */

    /** Feed ciphertext; returns bytes consumed (≥ 0). */
    private feedCipher(data: Uint8Array): number {
        const n = this.sslPipe!.feed(data);
        if (n < 0) throw new Error(`SSL feed error: ${n}`);
        return n;
    }

    /** Feed data then try to read plaintext in one shot. */
    private feedAndRead(data: Uint8Array, size: number): Uint8Array | null {
        this.feedCipher(data);
        return this.sslRead(size);
    }

    /** Read already-decrypted plaintext from SSL buffer. */
    private sslRead(size: number): Uint8Array | null {
        const plain = this.sslPipe!.read(size);
        return (plain && plain.byteLength > 0) ? new Uint8Array(plain) : null;
    }

    /** Check if an error code means the connection dropped. */
    static isDisconnectError(err: unknown): boolean {
        if (!(err instanceof Error)) return false;
        const code = (err as any).code;
        return code === error.errno.ECONNRESET ||
               code === error.errno.EPIPE      ||
               code === error.errno.EBADF;     // socket closed (e.g. by timeout)
    }
}
