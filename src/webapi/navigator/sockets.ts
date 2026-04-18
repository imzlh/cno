import type { SocketOptions, TCPSocket, UDPSocket, UDPMessage, DirectSockets } from './types';

const stream = import.meta.use('streams');
const udp = import.meta.use('udp');
const os = import.meta.use('os');

class TCPSocketImpl implements TCPSocket {
    private _tcp: CModuleStreams.TCP;
    private _readable: ReadableStream<Uint8Array>;
    private _writable: WritableStream<Uint8Array>;
    private _closedResolve!: () => void;
    private _closed: Promise<void>;
    private _buffer: Uint8Array;

    constructor(options: SocketOptions) {
        const isV4 = !options.remoteAddress?.includes(':');
        this._tcp = new stream.TCP(isV4 ? os.AF_INET : os.AF_INET6);
        this._buffer = new Uint8Array(65536);

        this._closed = new Promise<void>((resolve) => {
            this._closedResolve = resolve;
        });

        this._readable = new ReadableStream<Uint8Array>({
            pull: async (controller) => {
                try {
                    const nread = await this._tcp.read(this._buffer);
                    if (nread === null || nread === 0) {
                        controller.close();
                    } else {
                        controller.enqueue(this._buffer.slice(0, nread));
                    }
                } catch (e) {
                    controller.error(e);
                }
            },
            cancel: () => {
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
        try {
            this._tcp.close();
        } catch {}
        this._closedResolve();
    }
}

class UDPSocketImpl implements UDPSocket {
    private _udp: CModuleUDP.UDP | null = null;
    private _readable: ReadableStream<UDPMessage>;
    private _writable: WritableStream<UDPMessage>;
    private _closedResolve!: () => void;
    private _closed: Promise<void>;
    private _buffer: Uint8Array;

    constructor(options: SocketOptions) {
        this._buffer = new Uint8Array(65536);

        this._closed = new Promise<void>((resolve) => {
            this._closedResolve = resolve;
        });

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
        this._udp = await udp.create(isV4 ? os.AF_INET : os.AF_INET6);

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
            try {
                await this._udp.close();
            } catch {}
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
