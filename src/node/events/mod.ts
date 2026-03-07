/**
 * Node.js events 模块
 * 实现事件发射器模式
 */

// ============================================================================
// 类型定义
// ============================================================================

type EventMap<T> = Record<keyof T, any[]>;
type EventNames<T extends EventMap<T>> = keyof T | string | symbol;
type Listener<T extends EventMap<T>, E extends string | symbol> = (...args: any[]) => void;

export interface EventEmitterOptions {
    captureRejections?: boolean;
}

export interface StaticEventEmitterOptions {
    signal?: AbortSignal;
}

export interface EventEmitterAsyncResourceOptions extends EventEmitterOptions {
    name?: string;
    triggerAsyncId?: number;
    requireManualDestroy?: boolean;
}

// ============================================================================
// EventEmitter 类
// ============================================================================

export class EventEmitter<T extends EventMap<T> = any> {
    private _events: Map<string | symbol, Array<{ listener: Function; once: boolean }>> = new Map();
    private _maxListeners: number = 10;
    private _captureRejections: boolean = false;

    static captureRejectionSymbol = Symbol.for('nodejs.rejection');
    static errorMonitor = Symbol('events.errorMonitor');
    static usingDomains = false;

    constructor(options?: EventEmitterOptions) {
        if (options?.captureRejections) {
            this._captureRejections = true;
        }
    }

    // ============================================================================
    // 事件监听
    // ============================================================================

    addListener<E extends string | symbol>(eventName: E, listener: Listener<T, E>): this {
        return this.on(eventName, listener);
    }

    on<E extends string | symbol>(eventName: E, listener: Listener<T, E>): this {
        if (typeof listener !== 'function') {
            throw new TypeError('The "listener" argument must be of type Function');
        }

        let listeners = this._events.get(eventName);
        if (!listeners) {
            listeners = [];
            this._events.set(eventName, listeners);
        }

        listeners.push({ listener, once: false });

        // 发射 newListener 事件
        if (eventName !== 'newListener') {
            this.emit('newListener', eventName, listener);
        }

        // 检查 maxListeners 警告
        if (listeners.length > this._maxListeners && this._maxListeners !== 0) {
            console.warn(
                `Possible EventEmitter memory leak detected. ${listeners.length} ${String(eventName)} listeners added. Use emitter.setMaxListeners() to increase limit`
            );
        }

        return this;
    }

    once<E extends string | symbol>(eventName: E, listener: Listener<T, E>): this {
        if (typeof listener !== 'function') {
            throw new TypeError('The "listener" argument must be of type Function');
        }

        let listeners = this._events.get(eventName);
        if (!listeners) {
            listeners = [];
            this._events.set(eventName, listeners);
        }

        listeners.push({ listener, once: true });

        if (eventName !== 'newListener') {
            this.emit('newListener', eventName, listener);
        }

        return this;
    }

    prependListener<E extends string | symbol>(eventName: E, listener: Listener<T, E>): this {
        if (typeof listener !== 'function') {
            throw new TypeError('The "listener" argument must be of type Function');
        }

        let listeners = this._events.get(eventName);
        if (!listeners) {
            listeners = [];
            this._events.set(eventName, listeners);
        }

        listeners.unshift({ listener, once: false });
        return this;
    }

    prependOnceListener<E extends string | symbol>(eventName: E, listener: Listener<T, E>): this {
        if (typeof listener !== 'function') {
            throw new TypeError('The "listener" argument must be of type Function');
        }

        let listeners = this._events.get(eventName);
        if (!listeners) {
            listeners = [];
            this._events.set(eventName, listeners);
        }

        listeners.unshift({ listener, once: true });
        return this;
    }

    // ============================================================================
    // 移除监听器
    // ============================================================================

    removeListener<E extends string | symbol>(eventName: E, listener: Listener<T, E>): this {
        if (typeof listener !== 'function') {
            throw new TypeError('The "listener" argument must be of type Function');
        }

        const listeners = this._events.get(eventName);
        if (!listeners) return this;

        const index = listeners.findIndex(l => l.listener === listener);
        if (index !== -1) {
            listeners.splice(index, 1);
            if (listeners.length === 0) {
                this._events.delete(eventName);
            }
            this.emit('removeListener', eventName, listener);
        }

        return this;
    }

    off<E extends string | symbol>(eventName: E, listener: Listener<T, E>): this {
        return this.removeListener(eventName, listener);
    }

    removeAllListeners(eventName?: string | symbol): this {
        if (eventName === undefined) {
            this._events.clear();
        } else {
            this._events.delete(eventName);
        }
        return this;
    }

    // ============================================================================
    // 发射事件
    // ============================================================================

    emit<E extends string | symbol>(eventName: E, ...args: any[]): boolean {
        const listeners = this._events.get(eventName);
        if (!listeners || listeners.length === 0) {
            if (eventName === 'error') {
                const err = args[0];
                if (err instanceof Error) {
                    throw err;
                }
                throw new Error('Unhandled error.');
            }
            return false;
        }

        // 复制一份以防止在迭代时修改
        const toCall = [...listeners];

        // 移除 once 监听器
        for (let i = listeners.length - 1; i >= 0; i--) {
            if (listeners[i].once) {
                listeners.splice(i, 1);
            }
        }

        if (listeners.length === 0) {
            this._events.delete(eventName);
        }

        // 调用监听器
        for (const { listener } of toCall) {
            try {
                const result = listener(...args);
                if (this._captureRejections && result instanceof Promise) {
                    result.catch((err) => {
                        this.emit(EventEmitter.captureRejectionSymbol, err, eventName, ...args);
                    });
                }
            } catch (err) {
                if (eventName === 'error') {
                    throw err;
                }
                this.emit('error', err);
            }
        }

        return true;
    }

    // ============================================================================
    // 查询方法
    // ============================================================================

    eventNames(): Array<string | symbol> {
        return Array.from(this._events.keys());
    }

    listeners<E extends string | symbol>(eventName: E): Function[] {
        const listeners = this._events.get(eventName);
        return listeners ? listeners.map(l => l.listener) : [];
    }

    rawListeners<E extends string | symbol>(eventName: E): Function[] {
        return this.listeners(eventName);
    }

    listenerCount<E extends string | symbol>(eventName: E, listener?: Function): number {
        const listeners = this._events.get(eventName);
        if (!listeners) return 0;
        if (listener) {
            return listeners.filter(l => l.listener === listener).length;
        }
        return listeners.length;
    }

    // ============================================================================
    // maxListeners
    // ============================================================================

    getMaxListeners(): number {
        return this._maxListeners;
    }

    setMaxListeners(n: number): this {
        if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
            throw new RangeError('The value of "n" is out of range. It must be a non-negative number.');
        }
        this._maxListeners = n;
        return this;
    }

    // ============================================================================
    // 静态方法
    // ============================================================================

    static getEventListeners(emitter: EventEmitter | EventTarget, name: string | symbol): Function[] {
        if (emitter instanceof EventEmitter) {
            return emitter.listeners(name);
        }
        return [];
    }

    static getMaxListeners(emitter: EventEmitter | EventTarget): number {
        if (emitter instanceof EventEmitter) {
            return emitter.getMaxListeners();
        }
        return 10;
    }

    static setMaxListeners(n: number, ...eventTargets: Array<EventEmitter | EventTarget>): void {
        for (const target of eventTargets) {
            if (target instanceof EventEmitter) {
                target.setMaxListeners(n);
            }
        }
    }

    static listenerCount(emitter: EventEmitter, eventName: string | symbol): number {
        return emitter.listenerCount(eventName);
    }

    static on(emitter: EventEmitter, eventName: string, options?: StaticEventEmitterOptions): AsyncIterableIterator<any> {
        const signal = options?.signal;

        return {
            [Symbol.asyncIterator]() {
                return this;
            },
            async next() {
                return new Promise((resolve, reject) => {
                    if (signal?.aborted) {
                        reject(signal.reason);
                        return;
                    }

                    const onEvent = (...args: any[]) => {
                        cleanup();
                        resolve({ done: false, value: args.length === 1 ? args[0] : args });
                    };

                    const onAbort = () => {
                        cleanup();
                        reject(signal!.reason);
                    };

                    const cleanup = () => {
                        emitter.off(eventName, onEvent);
                        signal?.removeEventListener('abort', onAbort);
                    };

                    emitter.on(eventName, onEvent);
                    signal?.addEventListener('abort', onAbort, { once: true });
                });
            },
        } as AsyncIterableIterator<any>;
    }

    static once(emitter: EventEmitter, eventName: string, options?: StaticEventEmitterOptions): Promise<any[]> {
        return new Promise((resolve, reject) => {
            const signal = options?.signal;

            if (signal?.aborted) {
                reject(signal.reason);
                return;
            }

            const onEvent = (...args: any[]) => {
                cleanup();
                resolve(args);
            };

            const onAbort = () => {
                cleanup();
                reject(signal!.reason);
            };

            const cleanup = () => {
                emitter.off(eventName, onEvent);
                signal?.removeEventListener('abort', onAbort);
            };

            emitter.once(eventName, onEvent);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
}

// ============================================================================
// EventEmitterAsyncResource
// ============================================================================

export class EventEmitterAsyncResource extends EventEmitter {
    constructor(options?: EventEmitterAsyncResourceOptions) {
        super(options);
    }

    emit(eventName: string | symbol, ...args: any[]): boolean {
        return super.emit(eventName, ...args);
    }
}

// ============================================================================
// 辅助函数
// ============================================================================

export function getEventListeners(emitter: EventEmitter | EventTarget, name: string | symbol): Function[] {
    return EventEmitter.getEventListeners(emitter, name);
}

export function once(emitter: EventEmitter, eventName: string, options?: StaticEventEmitterOptions): Promise<any[]> {
    return EventEmitter.once(emitter, eventName, options);
}

export function on(emitter: EventEmitter, eventName: string, options?: StaticEventEmitterOptions): AsyncIterableIterator<any> {
    return EventEmitter.on(emitter, eventName, options);
}

export function setMaxListeners(n: number, ...eventTargets: Array<EventEmitter | EventTarget>): void {
    EventEmitter.setMaxListeners(n, ...eventTargets);
}