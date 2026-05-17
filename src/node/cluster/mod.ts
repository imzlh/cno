/**
 * Node.js cluster module (stub)
 * Single-process cluster - all methods delegate to process
 */

import { EventEmitter } from '../events';

export class Worker extends EventEmitter {
    id = 0;
    process = process;
    exitedAfterDisconnect = false;
    get isConnected(): boolean { return true; }
    get isDead(): boolean { return false; }
    send(_message: any, _sendHandle?: any, _options?: any, _callback?: (error?: Error | null) => void): boolean { return false; }
    kill(_signal?: string): void {}
    disconnect(): void {}
    destroy(_signal?: string): void {}
}

const _worker = new Worker();

export const isMaster = true;
export const isPrimary = true;
export const isWorker = false;
export const workers: Record<number, Worker> = {};
export const settings: Record<string, any> = {};
export const schedulingPolicy = 2;
export const SCHED_NONE = 1;
export const SCHED_RR = 2;

export function setupMaster(_settings?: any): void {}
export function fork(_env?: any): Worker { return _worker; }
export function disconnect(_callback?: () => void): void { _callback?.(); }
export function dispatch(_handle: any, _key: any): void {}
export function connect(): void {}
export function isConnected(): boolean { return false; }

export const events = new EventEmitter();
