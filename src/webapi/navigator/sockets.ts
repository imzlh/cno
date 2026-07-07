import type { SocketOptions, TCPSocket, UDPSocket, UDPMessage, DirectSockets } from './types';
import { concatChunks } from '../../utils/bytes';

const stream = import.meta.use('streams');
const udp = import.meta.use('udp');
const os = import.meta.use('os');

async function closeSocketHandleQuietly(handle: { close(): void | Promise<void> }): Promise<void> {
    try {
        await handle.close();
    } catch {
        // close() is best-effort once the stream side is being torn down.
    }
}

class TCPSocketImpl implements TCPSocket {
    private _tcp: CModuleStreams.TCP;
    private _readable: ReadableStream<Uint8Array>;
    private _writable: WritableStream<Uint8Array>;
    private _closedResolve: () => void;
    private _closed: Promise<void>;
    private _buffer: Uint8Array;
    private _pendingData: Uint8Array | null = null;

    constructor(options: SocketOptions) {
        const isV4 = !options.remoteAddress?.includes(':');
        this._tcp = new stream.TCP(isV4 ? os.AF_INET : os.AF_INET6);
        this._buffer = new Uint8Array(65536);

        const closed = Promise.withResolvers<void>();
        this._closed = closed.promise;
        this._closedResolve = closed.resolve;

        this._readable = new ReadableStream<Uint8Array>({
            start: (controller) => {
                const processData = (data: Uint8Array) => {
                    if (data.length === 0) {
                        this._tcp.startRead();
                        return;
                    }
                    const n = Math.min(data.byteLength, this._buffer.byteLength);
                    this._buffer.set(data.subarray(0, n));
                    controller.enqueue(this._buffer.slice(0, n));
                    if (data.byteLength > n) {
                        this._pendingData = data.subarray(n);
                    }
                    this._tcp.startRead();
                };

                this._tcp.onread = (data: Uint8Array | null | undefined, err?: CModuleError.Error) => {
                    if (data === undefined) {
                        if (err) {
                            controller.error(err);
                        }
                        return;
                    }
                    if (data === null) {
                        controller.close();
                        return;
                    }
                    if (this._pendingData) {
                        const combined = concatChunks([this._pendingData, data]);
                        this._pendingData = null;
                        processData(combined);
                    } else {
                        processData(data);
                    }
                };
                this._tcp.startRead();
            },
            cancel: () => {
                Reflect.set(this._tcp, 'onread', null);
                this._tcp.stopRead();
                this._pendingData = null;
                this.close();
            },
        });

        this._writable = new WritableStream<Uint8Array>({
            write: async (chunk) => {
                await this._tcp.write(chunk);
            },
            close: () => {
                this.close();
            },
        });
    }

    async connect(options: SocketOptions): Promise<void> {
        if (options.remoteAddress && options.remotePort) {
            await this._tcp.connect({
                ip: options.remoteAddress,
                port: options.remotePort,
            });
        }
        if (options.keepAlive !== undefined) {
            this._tcp.setKeepAlive(options.keepAlive, 0);
        }
        if (options.noDelay !== undefined) {
            this._tcp.setNoDelay(options.noDelay);
        }
    }

    get readable(): ReadableStream<Uint8Array> {
        return this._readable;
    }

    get writable(): WritableStream<Uint8Array> {
        return this._writable;
    }

    get closed(): Promise<void> {
        return this._closed;
    }

    async close(): Promise<void> {
        await closeSocketHandleQuietly(this._tcp);
        this._closedResolve();
    }
}

class UDPSocketImpl implements UDPSocket {
    private _udp: CModuleUDP.UDP | null = null;
    private _readable: ReadableStream<UDPMessage>;
    private _writable: WritableStream<UDPMessage>;
    private _closedResolve: () => void;
    private _closed: Promise<void>;
    private _buffer: Uint8Array;

    constructor(options: SocketOptions) {
        this._buffer = new Uint8Array(65536);

        const closed = Promise.withResolvers<void>();
        this._closed = closed.promise;
        this._closedResolve = closed.resolve;

        this._readable = new ReadableStream<UDPMessage>({
            pull: async (controller) => {
                if (!this._udp) return;
                try {
                    const result = await this._udp.recv(this._buffer);
                    if (result && result.nread > 0) {
                        controller.enqueue({
                            data: this._buffer.slice(0, result.nread),
                            remoteAddress: result.addr?.ip || '',
                            remotePort: result.addr?.port || 0,
                        });
                    }
                } catch (e) {
                    controller.error(e);
                }
            },
            cancel: () => {
                this.close();
            },
        });

        this._writable = new WritableStream<UDPMessage>({
            write: async (chunk) => {
                if (!this._udp) return;
                await this._udp.send(chunk.data, {
                    ip: chunk.remoteAddress,
                    port: chunk.remotePort,
                });
            },
            close: () => {
                this.close();
            },
        });
    }

    async bind(options: SocketOptions): Promise<void> {
        const isV4 = !options.localAddress?.includes(':');
        this._udp = new udp.UDP(isV4 ? os.AF_INET : os.AF_INET6);

        if (options.localAddress && options.localPort) {
            await this._udp.bind({
                ip: options.localAddress,
                port: options.localPort,
            });
        }
    }

    get readable(): ReadableStream<UDPMessage> {
        return this._readable;
    }

    get writable(): WritableStream<UDPMessage> {
        return this._writable;
    }

    get closed(): Promise<void> {
        return this._closed;
    }

    async close(): Promise<void> {
        if (this._udp) {
            await closeSocketHandleQuietly(this._udp);
        }
        this._closedResolve();
    }
}

class DirectSocketsImpl implements DirectSockets {
    async openTCPSocket(options: SocketOptions): Promise<TCPSocket> {
        const socket = new TCPSocketImpl(options);
        await socket.connect(options);
        return socket;
    }

    async openUDPSocket(options: SocketOptions): Promise<UDPSocket> {
        const socket = new UDPSocketImpl(options);
        await socket.bind(options);
        return socket;
    }
}

export function createDirectSockets(): DirectSockets {
    return new DirectSocketsImpl();
}
