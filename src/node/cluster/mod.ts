/**
 * node:cluster — primary-side surface only. This is a STUB: fork() throws, so
 * `workers` is always empty and no worker ever exists. Real forking needs
 * handle passing over IPC (SCM_RIGHTS / WSADuplicateSocket), which the host
 * IPC channel does not implement.
 */
import { EventEmitter } from '../events';

const os = import.meta.use('os');

export const SCHED_NONE = 1;
export const SCHED_RR = 2;
export const isWorker = false;
export const isMaster = true;
export const isPrimary = true;
export const workers: Record<string, never> = {};
export const settings: Record<string, unknown> = {};

// Node uses SCHED_RR everywhere except Windows (SCHED_NONE), and
// NODE_CLUSTER_SCHED_POLICY (rr|none) overrides it. os.getenv throws when unset.
let policy: string | undefined;
try { policy = os.getenv('NODE_CLUSTER_SCHED_POLICY'); } catch { /* unset */ }
export let schedulingPolicy = policy === 'rr'
    ? SCHED_RR
    : policy === 'none'
      ? SCHED_NONE
      : os.uname().sysname === 'Windows_NT' ? SCHED_NONE : SCHED_RR;

const cluster = new EventEmitter();

export const on = cluster.on.bind(cluster);
export const once = cluster.once.bind(cluster);
export const addListener = cluster.addListener.bind(cluster);
export const removeListener = cluster.removeListener.bind(cluster);
export const off = cluster.off.bind(cluster);
export const removeAllListeners = cluster.removeAllListeners.bind(cluster);
export const emit = cluster.emit.bind(cluster);
export const listeners = cluster.listeners.bind(cluster);
export const listenerCount = cluster.listenerCount.bind(cluster);

/**
 * Node exposes cluster.Worker as a constructor even in the primary. Nothing
 * here can construct a live worker — the class exists so `instanceof` probes
 * and prototype checks in npm packages do not throw on a missing export.
 */
export class Worker extends EventEmitter {
    id = 0;
    process: unknown = null;
    exitedAfterDisconnect = false;

    kill(_signal?: string): void {}
    destroy(_signal?: string): void {}
    disconnect(): this { return this; }
    isDead(): boolean { return true; }
    isConnected(): boolean { return false; }
    send(_message: unknown, _sendHandle?: unknown, _callback?: unknown): boolean { return false; }
}

export function setupPrimary(options: Record<string, unknown> = {}): void {
    Object.assign(settings, options);
    emit('setup', settings);
}

export const setupMaster = setupPrimary;

export function fork(): never {
    throw new Error('node:cluster worker processes are not supported by this runtime');
}

export function disconnect(callback?: () => void): void {
    queueMicrotask(() => {
        emit('disconnect');
        callback?.();
    });
}
