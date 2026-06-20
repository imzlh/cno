/**
 * Node.js worker_threads module
 * Based on CModuleWorker implementation
 */

import { EventEmitter } from '../events';

const wk = import.meta.use('worker');
const engine = import.meta.use('engine');

const INTERNAL_KEYS = new Set(['__cts_entry', '__cts_role', '__node_workerData', 'name']);
const otherPortSymbol = Symbol('otherPort');
const startedSymbol = Symbol('started');
const closedSymbol = Symbol('closed');
const messageQueueSymbol = Symbol('messageQueue');

function wrapMessagePipe(pipe: CModuleWorker.MessagePipe): MessagePort {
    const port = new MessagePort();
    pipe.onmessage = (data: any) => {
        port.emit('message', data);
        port.onmessage?.call(port, { type: 'message', data } as any);
    };
    pipe.onmessageerror = (err: any) => {
        port.emit('messageerror', err);
        port.onmessageerror?.call(port, { type: 'messageerror', data: err } as any);
    };
    (port as any).__pipe = pipe;
    return port;
}

export class MessagePort extends EventEmitter {
    private readonly events = new EventEmitter();
    onmessage: ((this: MessagePort, ev: { type: string; data: any; ports?: MessagePort[] }) => any) | null = null;
    onmessageerror: ((this: MessagePort, ev: { type: string; data: any }) => any) | null = null;
    [otherPortSymbol]: MessagePort | null = null;
    [startedSymbol] = false;
    [closedSymbol] = false;
    [messageQueueSymbol]: any[] = [];

    postMessage(value: any, transferList?: any[]): void {
        const pipe = (this as any).__pipe as CModuleWorker.MessagePipe | undefined;
        if (pipe) {
            pipe.postMessage(value);
            return;
        }

        if (this[closedSymbol]) return;
        const otherPort = this[otherPortSymbol];
        if (!otherPort || otherPort[closedSymbol]) return;

        const cloned = engine.deserialize(engine.serialize(value));
        const ports = (transferList ?? []).filter(item => item instanceof MessagePort) as MessagePort[];

        if (otherPort[startedSymbol]) {
            queueMicrotask(() => {
                if (!otherPort[closedSymbol]) {
                    const event = { type: 'message', data: cloned, ports };
                    otherPort.emit('message', cloned);
                    otherPort.onmessage?.call(otherPort, event);
                }
            });
        } else {
            otherPort[messageQueueSymbol].push({ data: cloned, ports });
        }
    }
    close(): void {
        this[closedSymbol] = true;
        this[otherPortSymbol] = null;
        this[messageQueueSymbol] = [];
        this.events.emit('close');
    }
    ref(): void {}
    unref(): void {}
    start(): void {
        if (this[startedSymbol]) return;
        this[startedSymbol] = true;
        for (const item of this[messageQueueSymbol]) {
            const event = { type: 'message', data: item.data, ports: item.ports };
            this.emit('message', item.data);
            this.onmessage?.call(this, event);
        }
        this[messageQueueSymbol] = [];
    }

    // @ts-ignore
    on(event: string, listener: (...args: any[]) => void): this {
        this.events.on(event, listener as any);
        if (event === 'message' && !this[startedSymbol]) this.start();
        return this;
    }

    // @ts-ignore
    off(event: string, listener: (...args: any[]) => void): this {
        this.events.off(event, listener as any);
        return this;
    }

    // @ts-ignore
    once(event: string, listener: (...args: any[]) => void): this {
        this.events.once(event, listener as any);
        return this;
    }

    // @ts-ignore
    emit(event: string, ...args: any[]): boolean {
        return this.events.emit(event, ...args);
    }
}

export class MessageChannel {
    readonly port1: MessagePort;
    readonly port2: MessagePort;

    constructor() {
        this.port1 = new MessagePort();
        this.port2 = new MessagePort();
        this.port1[otherPortSymbol] = this.port2;
        this.port2[otherPortSymbol] = this.port1;
    }
}

export class Worker extends EventEmitter {
    readonly threadId = 0;
    readonly resourceLimits: Record<string, number> = {};
    private _native: CModuleWorker.Worker;
    private _port: MessagePort;
    private _exited = false;

    constructor(filename: string | URL, options?: { eval?: boolean; workerData?: any; transferList?: any[]; resourceLimits?: Record<string, number>; stdin?: boolean; stdout?: boolean; stderr?: boolean }) {
        super();
        this._native = new wk.Worker({
            __cts_entry: filename.toString(),
            __node_workerData: options?.workerData,
        });
        this._port = wrapMessagePipe(this._native.messagePipe);
        this._port.on('message', (data: any) => this.emit('message', data));
        this._port.on('messageerror', (err: any) => this.emit('error', err));
    }

    postMessage(value: any, transferList?: any[]): void {
        if (this._exited) return;
        this._native.messagePipe.postMessage(value);
    }
    postMessageToThread(_threadId: number, _value: any, _transferList?: any[], _timeout?: number): void {}
    terminate() {
        if (this._exited) return Promise.resolve(0);
        this._exited = true;
        return this._native.terminate();
    }
    ref(): void {}
    unref(): void {}

    get stdin(): NodeJS.ReadableStream | null { return null; }
    get stdout(): NodeJS.ReadableStream | null { return null; }
    get stderr(): NodeJS.ReadableStream | null { return null; }
    get performance(): { eventLoopUtilization(): { idle: number; active: number; utilization: number } } {
        return { eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }) };
    }
}

export const isMainThread = !wk.isWorker;

export const parentPort: MessagePort | null = wk.isWorker && wk.pipe
    ? wrapMessagePipe(wk.pipe)
    : null;

export const threadId = 0;

const rawWorkerData = wk.workerData;
export const workerData: unknown = (rawWorkerData && typeof rawWorkerData === 'object' && '__node_workerData' in (rawWorkerData as object))
    ? (rawWorkerData as any).__node_workerData
    : (rawWorkerData && typeof rawWorkerData === 'object')
        ? Object.fromEntries(
            Object.entries(rawWorkerData as Record<string, any>)
                .filter(([k]) => !INTERNAL_KEYS.has(k))
        ) || undefined
        : rawWorkerData;

export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');
export function moveMessagePortToContext(_port: MessagePort, _context: any): MessagePort { return new MessagePort(); }

const envDataMap = new Map<string | symbol, any>();
export function getEnvironmentData(key: string | symbol): any { return envDataMap.get(key); }
export function setEnvironmentData(key: string | symbol, value?: any): void {
    if (value === undefined) envDataMap.delete(key);
    else envDataMap.set(key, value);
}
export function markAsUntransferable(_object: object): void {}
export function markAsUncloneable(_object: object): void {}
export function isMarkedAsUntransferable(_object: object): boolean { return false; }
