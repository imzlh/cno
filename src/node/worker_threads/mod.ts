/**
 * Node.js worker_threads module (stub)
 * Worker threads for parallel JavaScript execution
 */

import { EventEmitter } from '../events';

export class MessagePort extends EventEmitter {
    postMessage(_value: any, _transferList?: any[]): void {}
    close(): void { this.emit('close'); }
    ref(): void {}
    unref(): void {}
    start(): void {}
    addEventListener(_type: string, _listener: Function): void {}
    removeEventListener(_type: string, _listener: Function): void {}
    dispatchEvent(_event: Event): boolean { return false; }
}

export class Worker extends EventEmitter {
    readonly threadId = 0;
    readonly resourceLimits: Record<string, number> = {};
    private _exited = false;

    constructor(_filename: string | URL, _options?: { eval?: boolean; workerData?: any; transferList?: any[]; resourceLimits?: Record<string, number>; stdin?: boolean; stdout?: boolean; stderr?: boolean }) {}

    postMessage(_value: any, _transferList?: any[]): void {}
    postMessageToThread(_threadId: number, _value: any, _transferList?: any[], _timeout?: number): void {}
    terminate(): Promise<number> { this._exited = true; return Promise.resolve(0); }
    ref(): void {}
    unref(): void {}

    get stdin(): NodeJS.ReadableStream | null { return null; }
    get stdout(): NodeJS.ReadableStream | null { return null; }
    get stderr(): NodeJS.ReadableStream | null { return null; }
    get performance(): { eventLoopUtilization(): { idle: number; active: number; utilization: number } } {
        return { eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }) };
    }
}

export const isMainThread = true;
export const parentPort: MessagePort | null = null;
export const threadId = 0;
export const workerData: unknown = undefined;
export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV');
export const moveMessagePortToContext(_port: MessagePort, _context: any): MessagePort { return new MessagePort(); }

export function getEnvironmentData(_key: string | symbol): any { return undefined; }
export function setEnvironmentData(_key: string | symbol, _value?: any): void {}
export function markAsUntransferable(_object: object): void {}
export function markAsUncloneable(_object: object): void {}
export function isMarkedAsUntransferable(_object: object): boolean { return false; }
