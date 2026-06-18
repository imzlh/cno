/**
 * EventSource — Server-Sent Events (SSE) client.
 * Connects to an SSE endpoint, parses the event stream protocol, dispatches events, and handles automatic reconnection.
 *
 * Merged from: cno/src/module/http/sse.ts
 */

import { Headers } from "headers-polyfill";
import { HttpResponseParser } from "@cnojs/http/h1";
import { connectTcp, buildRequest, readHeaders, type IHttpSocket } from "../utils/http";
import { MessageEvent } from "./events";

const engine = import.meta.use('engine');
const timers = import.meta.use('timers');
const console = import.meta.use('console');

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

export enum EventSourceReadyState {
    CONNECTING = 0,
    OPEN = 1,
    CLOSED = 2
}

export class EventSource extends EventTarget {
    static readonly CONNECTING = EventSourceReadyState.CONNECTING;
    static readonly OPEN = EventSourceReadyState.OPEN;
    static readonly CLOSED = EventSourceReadyState.CLOSED;

    public readonly url: string;
    public readonly withCredentials: boolean;
    public readyState: EventSourceReadyState = EventSourceReadyState.CONNECTING;

    public onopen: ((this: EventSource, ev: Event) => any) | null = null;
    public onmessage: ((this: EventSource, ev: MessageEvent) => any) | null = null;
    public onerror: ((this: EventSource, ev: Event) => any) | null = null;

    private connection: IHttpSocket | null = null;
    private parser: HttpResponseParser | null = null;
    private reconnectTimer: number | null = null;
    private reconnectDelay: number = 3000;
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
        this.connect();
    }

    private async connect(): Promise<void> {
        try {
            const url = new URL(this.url);

            this.connection = await connectTcp(url);
            if (this.readyState === EventSourceReadyState.CLOSED) {
                this.closeConnection();
                return;
            }

            const headers = new Headers();
            headers.set('accept', 'text/event-stream');
            headers.set('cache-control', 'no-cache');
            if (this.lastEventId) headers.set('last-event-id', this.lastEventId);

            await this.connection.write(buildRequest({ method: 'GET', url, headers }));

            this.parser = new HttpResponseParser();
            const { status, headers: resHeaders } = await readHeaders(this.connection, this.parser);

            if (status !== 200) { this.fail(); return; }
            const contentType = resHeaders.find(([n]) => n === 'content-type')?.[1];
            if (!contentType || !contentType.includes('text/event-stream')) { this.fail(); return; }

            this.readyState = EventSourceReadyState.OPEN;
            this.dispatchEvent(new Event('open'));
            this.onopen?.call(this, new Event('open'));

            // Process any body data that arrived in the same chunk as headers
            const pending = this.parser.getBodyChunks();
            for (const chunk of pending) this.processChunk(chunk);

            // Switch to event-driven body reading
            this.setupBodyReader();
        } catch (err) { this.handleError(err as Error); }
    }

    private setupBodyReader(): void {
        if (!this.connection || !this.parser) return;
        const conn = this.connection;
        const parser = this.parser;

        parser.onData = (chunk) => { this.processChunk(chunk); };
        parser.onComplete = () => { this.reconnect(); };
        parser.onError = (err) => { this.handleError(err); };

        conn.onReadable(data => {
            if (!data) { this.reconnect(); return; }
            parser.feed(data);
        }, err => {
            if (this.readyState !== EventSourceReadyState.CLOSED) this.handleError(err);
        });
    }

    private processChunk(chunk: Uint8Array): void {
        const text = engine.decodeString(chunk);
        this.lineBuffer += text;
        let newlineIndex: number;
        while ((newlineIndex = this.lineBuffer.indexOf('\n')) !== -1) {
            const line = this.lineBuffer.slice(0, newlineIndex);
            this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
            this.processLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        }
    }

    private processLine(line: string): void {
        if (line.length === 0) { this.dispatchBufferedEvent(); return; }
        if (line.startsWith(':')) return;

        const colonIndex = line.indexOf(':');
        let field: string, value: string;
        if (colonIndex === -1) { field = line; value = ''; }
        else { field = line.slice(0, colonIndex); value = line.slice(colonIndex + 1); if (value.startsWith(' ')) value = value.slice(1); }

        switch (field) {
            case 'event': this.eventTypeBuffer = value; break;
            case 'data': this.dataBuffer.push(value); break;
            case 'id': if (!value.includes('\0')) this.idBuffer = value; break;
            case 'retry': { const r = parseInt(value); if (!isNaN(r) && r >= 0) { this.retryBuffer = value; this.reconnectDelay = r; } break; }
        }
    }

    private dispatchBufferedEvent(): void {
        if (this.dataBuffer.length === 0) return;
        if (this.idBuffer) this.lastEventId = this.idBuffer;
        const data = this.dataBuffer.join('\n');
        const eventType = this.eventTypeBuffer || 'message';
        const event = new MessageEvent(eventType, { 
            data, origin: new URL(this.url).origin, lastEventId: this.lastEventId
        }, true);
        this.dispatchEvent(event);
        if (eventType === 'message' && this.onmessage) this.onmessage.call(this, event);
        this.eventTypeBuffer = ''; this.dataBuffer = []; this.idBuffer = '';
    }

    private handleError(err: Error): void {
        console.error('EventSource error:', err);
        this.closeConnection();
        const errorEvent = new Event('error');
        this.dispatchEvent(errorEvent);
        this.onerror?.call(this, errorEvent);
        this.reconnect();
    }

    private reconnect(): void {
        if (this.readyState === EventSourceReadyState.CLOSED) return;
        this.closeConnection();
        this.readyState = EventSourceReadyState.CONNECTING;
        if (this.reconnectTimer !== null) timers.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = timers.setTimeout(() => {
            this.reconnectTimer = null;
            if (this.readyState === EventSourceReadyState.CONNECTING) this.connect();
        }, this.reconnectDelay);
    }

    private fail(): void {
        this.closeConnection();
        this.readyState = EventSourceReadyState.CLOSED;
        const errorEvent = new Event('error');
        this.dispatchEvent(errorEvent);
        this.onerror?.call(this, errorEvent);
    }

    private closeConnection(): void {
        if (this.connection) {
            try { this.connection.close(); } catch { }
            this.connection = null;
        }
        this.parser = null;
    }

    close(): void {
        if (this.readyState === EventSourceReadyState.CLOSED) return;
        if (this.reconnectTimer !== null) { timers.clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.closeConnection();
        this.readyState = EventSourceReadyState.CLOSED;
    }

    addEventListener(
        type: 'open' | 'message' | 'error',
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
    ): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
        super.addEventListener(type, listener, options);
    }

    removeEventListener(
        type: 'open' | 'message' | 'error',
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
    ): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void {
        super.removeEventListener(type, listener, options);
    }
}

Reflect.set(globalThis, 'EventSource', EventSource);