import { EventEmitter } from '../events';

export const SCHED_NONE = 1;
export const SCHED_RR = 2;
export const isWorker = false;
export const isMaster = true;
export const isPrimary = true;
export const workers: Record<string, never> = {};
export const settings: Record<string, unknown> = {};
export let schedulingPolicy = SCHED_RR;

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

export function setupPrimary(options: Record<string, unknown> = {}): void {
    Object.assign(settings, options);
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
