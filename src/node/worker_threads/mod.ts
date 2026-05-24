/**
 * Node.js worker_threads module
 * Based on CModuleWorker implementation
 */

import { EventEmitter } from '../events';

const wk = import.meta.use('worker');

const INTERNAL_KEYS = new Set(['__cts_entry', '__cts_role', '__node_workerData', 'name']);

function wrapMessagePipe(pipe: CModuleWorker.MessagePipe): MessagePort {
    const port = new MessagePort();
    pipe.onmessage = (data: any) => {
        port.emit('message', data);
    };
    pipe.onmessageerror = (err: any) => {
        port.emit('messageerror', err);
    };
    (port as any).__pipe = pipe;
    return port;
}

export class MessagePort extends EventEmitter {
    postMessage(value: any, _transferList?: any[]): void {
        const pipe = (this as any).__pipe as CModuleWorker.MessagePipe | undefined;
        if (pipe) {
            pipe.postMessage(value);
        }
    }
    close(): void { this.emit('close'); }
    ref(): void {}
    unref(): void {}
    start(): void {}
    addEventListener(type: string, listener: Function): void { this.on(type, listener as any); }
    removeEventListener(type: string, listener: Function): void { this.off(type, listener as any); }
    dispatchEvent(event: Event): boolean { return this.emit(event.type, event); }
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
    terminate(): Promise<number> {
        if (this._exited) return Promise.resolve(0);
        this._exited = true;
        return this._native.terminate().then(() => 0);
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
