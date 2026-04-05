const engine = import.meta.use('engine');
const timers = import.meta.use('timers');

import { Headers } from 'headers-polyfill';
import { connectionManager, Connection } from './connection';
import {
    HttpRequestBuilder,
    HttpResponseParser
} from './http';

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

/* ------------------------------------------------------------------ */
/* EventSource Ready State                                            */
/* ------------------------------------------------------------------ */

export enum EventSourceReadyState {
    CONNECTING = 0,
    OPEN = 1,
    CLOSED = 2
}

/* ------------------------------------------------------------------ */
/* EventSource Implementation                                         */
/* ------------------------------------------------------------------ */

export class EventSource extends EventTarget {
    // Constants
    static readonly CONNECTING = EventSourceReadyState.CONNECTING;
    static readonly OPEN = EventSourceReadyState.OPEN;
    static readonly CLOSED = EventSourceReadyState.CLOSED;

    // Properties
    public readonly url: string;
    public readonly withCredentials: boolean;
    public readyState: EventSourceReadyState = EventSourceReadyState.CONNECTING;

    // Event handlers
    public onopen: ((this: EventSource, ev: Event) => any) | null = null;
    public onmessage: ((this: EventSource, ev: MessageEvent) => any) | null = null;
    public onerror: ((this: EventSource, ev: Event) => any) | null = null;

    // Internal state
    private connection: Connection | null = null;
    private parser: HttpResponseParser | null = null;
    private reconnectTimer: number | null = null;
    private reconnectDelay: number = 3000; // Default 3 seconds
    private lastEventId: string = '';
    private eventTypeBuffer: string = '';
    private dataBuffer: string[] = [];
    private idBuffer: string = '';
    private retryBuffer: string = '';
    private lineBuffer: string = '';

    constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super();

        this.url = url instanceof URL ? url.toString() : url;
        this.withCredentials = eventSourceInitDict?.withCredentials || false;

        // Start connection
        this.connect();
    }

    /* -------------------------------------------------------------- */
    /* Connection Management                                          */
    /* -------------------------------------------------------------- */

    /**
     * Connect to the server
     */
    private async connect(): Promise<void> {
        try {
            const url = new URL(this.url);
            const port = url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 80);

            // Acquire connection
            this.connection = await connectionManager.acquire({
                hostname: url.hostname,
                port,
                protocol: url.protocol as 'http:' | 'https:',
                keepAlive: true, // SSE uses persistent connection
                timeout: 0 // No timeout for SSE
            });

            // Build request
            const headers = new Headers();
            headers.set('accept', 'text/event-stream');
            headers.set('cache-control', 'no-cache');

            if (this.lastEventId) {
                headers.set('last-event-id', this.lastEventId);
            }

            const builder = new HttpRequestBuilder(url, {
                method: 'GET',
                headers: headers as any
            });

            const requestBytes = builder.build();

            // Send request
            await this.connection.write(requestBytes);

            // Create parser
            this.parser = new HttpResponseParser();

            // Setup parser callbacks
            this.setupParser();

            // Start reading response
            await this.readResponse();

        } catch (err) {
            this.handleError(err as Error);
        }
    }

    /**
     * Setup HTTP response parser
     */
    private setupParser(): void {
        if (!this.parser) return;

        this.parser.onHeadersComplete = (status, headers) => {
            if (status !== 200) {
                this.fail();
                return;
            }

            const contentType = headers.get('content-type');
            if (!contentType || !contentType.includes('text/event-stream')) {
                this.fail();
                return;
            }

            // Connection established
            this.readyState = EventSourceReadyState.OPEN;
            this.dispatchEvent(new Event('open'));
            if (this.onopen) {
                this.onopen.call(this, new Event('open'));
            }
        };

        this.parser.onData = (chunk) => {
            // Process SSE data
            this.processChunk(chunk);
        };

        this.parser.onComplete = () => {
            // Server closed connection, try to reconnect
            this.reconnect();
        };

        this.parser.onError = (err) => {
            this.handleError(err);
        };
    }

    /**
     * Read HTTP response
     */
    private async readResponse(): Promise<void> {
        if (!this.connection || !this.parser) return;

        try {
            // Read headers
            while (!this.parser.isHeadersComplete) {
                const data = await this.connection.read();
                if (!data || data.length === 0) {
                    throw new Error('Connection closed while reading headers');
                }
                this.parser.feed(data);
            }

            // Read body (event stream)
            while (this.readyState !== EventSourceReadyState.CLOSED) {
                const data = await this.connection.read();
                if (!data || data.length === 0) {
                    // EOF
                    this.reconnect();
                    return;
                }

                this.parser.feed(data);
            }

        } catch (err) {
            if (this.readyState !== EventSourceReadyState.CLOSED) {
                this.handleError(err as Error);
            }
        }
    }

    /* -------------------------------------------------------------- */
    /* SSE Protocol Processing                                        */
    /* -------------------------------------------------------------- */

    /**
     * Process incoming data chunk
     */
    private processChunk(chunk: Uint8Array): void {
        const text = engine.decodeString(chunk);

        // Add to line buffer
        this.lineBuffer += text;

        // Process complete lines
        let newlineIndex: number;
        while ((newlineIndex = this.lineBuffer.indexOf('\n')) !== -1) {
            const line = this.lineBuffer.slice(0, newlineIndex);
            this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

            // Remove \r if present (handles both \n and \r\n)
            const cleanLine = line.endsWith('\r') ? line.slice(0, -1) : line;

            this.processLine(cleanLine);
        }
    }

    /**
     * Process a single SSE line
     */
    private processLine(line: string): void {
        // Empty line = dispatch event
        if (line.length === 0) {
            this.dispatchBufferedEvent();
            return;
        }

        // Comment line (starts with :)
        if (line.startsWith(':')) {
            return;
        }

        // Parse field
        const colonIndex = line.indexOf(':');
        let field: string;
        let value: string;

        if (colonIndex === -1) {
            field = line;
            value = '';
        } else {
            field = line.slice(0, colonIndex);
            value = line.slice(colonIndex + 1);

            // Remove leading space from value
            if (value.startsWith(' ')) {
                value = value.slice(1);
            }
        }

        // Process field
        switch (field) {
            case 'event':
                this.eventTypeBuffer = value;
                break;

            case 'data':
                this.dataBuffer.push(value);
                break;

            case 'id':
                // ID cannot contain null character
                if (!value.includes('\0')) {
                    this.idBuffer = value;
                }
                break;

            case 'retry':
                const retry = parseInt(value);
                if (!isNaN(retry) && retry >= 0) {
                    this.retryBuffer = value;
                    this.reconnectDelay = retry;
                }
                break;

            default:
                // Ignore unknown fields
                break;
        }
    }

    /**
     * Dispatch buffered event
     */
    private dispatchBufferedEvent(): void {
        // Only dispatch if data is present
        if (this.dataBuffer.length === 0) {
            return;
        }

        // Update last event ID
        if (this.idBuffer) {
            this.lastEventId = this.idBuffer;
        }

        // Build event data (join with \n)
        const data = this.dataBuffer.join('\n');

        // Determine event type
        const eventType = this.eventTypeBuffer || 'message';

        // Create and dispatch event
        const event = new MessageEvent(eventType, {
            data,
            origin: new URL(this.url).origin,
            lastEventId: this.lastEventId
        });

        this.dispatchEvent(event);

        // Call onmessage for 'message' events
        if (eventType === 'message' && this.onmessage) {
            this.onmessage.call(this, event);
        }

        // Clear buffers
        this.eventTypeBuffer = '';
        this.dataBuffer = [];
        this.idBuffer = '';
    }

    /* -------------------------------------------------------------- */
    /* Error Handling & Reconnection                                  */
    /* -------------------------------------------------------------- */

    /**
     * Handle connection error
     */
    private handleError(err: Error): void {
        console.error('EventSource error:', err);

        // Close current connection
        this.closeConnection();

        // Fire error event
        const errorEvent = new Event('error');
        this.dispatchEvent(errorEvent);
        if (this.onerror) {
            this.onerror.call(this, errorEvent);
        }

        // Try to reconnect
        this.reconnect();
    }

    /**
     * Reconnect after delay
     */
    private reconnect(): void {
        if (this.readyState === EventSourceReadyState.CLOSED) {
            return;
        }

        // Close current connection
        this.closeConnection();

        // Set state to connecting
        this.readyState = EventSourceReadyState.CONNECTING;

        // Clear reconnect timer if exists
        if (this.reconnectTimer !== null) {
            timers.clearTimeout(this.reconnectTimer);
        }

        // Schedule reconnection
        this.reconnectTimer = timers.setTimeout(() => {
            this.reconnectTimer = null;
            if (this.readyState === EventSourceReadyState.CONNECTING) {
                this.connect();
            }
        }, this.reconnectDelay);
    }

    /**
     * Fail connection (no reconnect)
     */
    private fail(): void {
        this.closeConnection();
        this.readyState = EventSourceReadyState.CLOSED;

        const errorEvent = new Event('error');
        this.dispatchEvent(errorEvent);
        if (this.onerror) {
            this.onerror.call(this, errorEvent);
        }
    }

    /**
     * Close current connection
     */
    private closeConnection(): void {
        if (this.connection) {
            const url = new URL(this.url);
            const port = url.port ? parseInt(url.port) : (url.protocol === 'https:' ? 443 : 80);

            connectionManager.release({
                hostname: url.hostname,
                port,
                protocol: url.protocol as 'http:' | 'https:'
            }, this.connection);

            this.connection = null;
        }

        this.parser = null;
    }

    /* -------------------------------------------------------------- */
    /* Public API                                                     */
    /* -------------------------------------------------------------- */

    /**
     * Close the connection
     */
    close(): void {
        if (this.readyState === EventSourceReadyState.CLOSED) {
            return;
        }

        // Cancel reconnection timer
        if (this.reconnectTimer !== null) {
            timers.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Close connection
        this.closeConnection();

        // Set state to closed
        this.readyState = EventSourceReadyState.CLOSED;
    }

    /* -------------------------------------------------------------- */
    /* Event Listener Type Safety                                     */
    /* -------------------------------------------------------------- */

    addEventListener(
        type: 'open' | 'message' | 'error',
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
    ): void;
    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
    ): void {
        super.addEventListener(type, listener, options);
    }

    removeEventListener(
        type: 'open' | 'message' | 'error',
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
    ): void;
    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
    ): void {
        super.removeEventListener(type, listener, options);
    }
}

Reflect.set(globalThis, 'EventSource', EventSource);