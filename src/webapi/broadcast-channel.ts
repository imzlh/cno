import { DOMException, Event, EventTarget, MessageEvent } from './events';

const channels = new Map<string, Set<BroadcastChannelImpl>>();
const remoteByName = new Map<string, Set<RemoteBroadcastChannel>>();
const remoteByPipe = new Map<CModuleWorker.MessagePipe, Set<RemoteBroadcastChannel>>();
const workerRuntime = import.meta.use('worker');
type BroadcastChannelHandler = (this: BroadcastChannel, ev: globalThis.MessageEvent<unknown>) => unknown;
type BroadcastOp = 'subscribe' | 'unsubscribe' | 'post' | 'deliver';
type BroadcastPayload = {
    op: BroadcastOp;
    id: string;
    name?: string;
    data?: unknown;
};
type BroadcastEnvelope = { __cno_broadcast: BroadcastPayload };
type RemoteBroadcastChannel = {
    pipe: CModuleWorker.MessagePipe;
    id: string;
    name: string;
};

let nextChannelId = 0;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isBroadcastEnvelope(value: unknown): value is BroadcastEnvelope {
    if (!isRecord(value)) return false;
    return isRecord(value.__cno_broadcast);
}

function addRemote(remote: RemoteBroadcastChannel): void {
    let byName = remoteByName.get(remote.name);
    if (!byName) {
        byName = new Set();
        remoteByName.set(remote.name, byName);
    }
    byName.add(remote);

    let byPipe = remoteByPipe.get(remote.pipe);
    if (!byPipe) {
        byPipe = new Set();
        remoteByPipe.set(remote.pipe, byPipe);
    }
    byPipe.add(remote);
}

function removeRemote(remote: RemoteBroadcastChannel): void {
    const byName = remoteByName.get(remote.name);
    byName?.delete(remote);
    if (byName?.size === 0) remoteByName.delete(remote.name);

    const byPipe = remoteByPipe.get(remote.pipe);
    byPipe?.delete(remote);
    if (byPipe?.size === 0) remoteByPipe.delete(remote.pipe);
}

function findRemote(pipe: CModuleWorker.MessagePipe, id: string): RemoteBroadcastChannel | null {
    for (const remote of remoteByPipe.get(pipe) ?? []) {
        if (remote.id === id) return remote;
    }
    return null;
}

function postToRemote(remote: RemoteBroadcastChannel, data: unknown): void {
    remote.pipe.postMessage({
        __cno_broadcast: {
            op: 'deliver',
            id: remote.id,
            data: structuredClone(data),
        },
    });
}

function deliverLocal(name: string, source: BroadcastChannelImpl | null, data: unknown): void {
    const peers = channels.get(name);
    if (!peers) return;
    for (const peer of peers) {
        if (peer === source || peer.closed) continue;
        peer.dispatchBroadcastMessage(structuredClone(data));
    }
}

function deliverRemote(name: string, source: RemoteBroadcastChannel | null, data: unknown): void {
    const remotes = remoteByName.get(name);
    if (!remotes) return;
    for (const remote of remotes) {
        if (source && remote.pipe === source.pipe && remote.id === source.id) continue;
        postToRemote(remote, data);
    }
}

function postToParent(payload: BroadcastPayload): void {
    workerRuntime.pipe?.postMessage({ __cno_broadcast: payload });
}

export function handleWorkerBroadcastControl(pipe: CModuleWorker.MessagePipe, data: unknown): boolean {
    if (!isBroadcastEnvelope(data)) return false;
    const payload = data.__cno_broadcast;
    if (typeof payload.id !== 'string') return false;

    if (payload.op === 'subscribe') {
        if (typeof payload.name !== 'string') return true;
        const existing = findRemote(pipe, payload.id);
        if (existing) removeRemote(existing);
        addRemote({ pipe, id: payload.id, name: payload.name });
        return true;
    }

    if (payload.op === 'unsubscribe') {
        const remote = findRemote(pipe, payload.id);
        if (remote) removeRemote(remote);
        return true;
    }

    if (payload.op === 'post') {
        const remote = findRemote(pipe, payload.id);
        if (!remote) return true;
        const cloned = structuredClone(payload.data);
        deliverLocal(remote.name, null, cloned);
        deliverRemote(remote.name, remote, cloned);
        return true;
    }

    return false;
}

export function handleBroadcastDelivery(data: unknown): boolean {
    if (!isBroadcastEnvelope(data)) return false;
    const payload = data.__cno_broadcast;
    if (payload.op !== 'deliver' || typeof payload.id !== 'string') return false;
    const channel = channelById.get(payload.id);
    if (channel && !channel.closed) channel.dispatchBroadcastMessage(payload.data);
    return true;
}

export function detachWorkerBroadcastPipe(pipe: CModuleWorker.MessagePipe): void {
    for (const remote of Array.from(remoteByPipe.get(pipe) ?? [])) {
        removeRemote(remote);
    }
}

const channelById = new Map<string, BroadcastChannelImpl>();

class BroadcastChannelImpl extends EventTarget implements BroadcastChannel {
    readonly name: string;
    readonly id: string;
    #closed = false;

    constructor(name: string) {
        super();
        this.name = String(name);
        this.id = `bc-${++nextChannelId}`;
        channelById.set(this.id, this);
        let peers = channels.get(this.name);
        if (!peers) {
            peers = new Set();
            channels.set(this.name, peers);
        }
        peers.add(this);
        if (workerRuntime.isWorker) {
            postToParent({ op: 'subscribe', id: this.id, name: this.name });
        }
    }

    get closed(): boolean {
        return this.#closed;
    }

    postMessage(data: unknown): void {
        if (this.#closed) {
            throw new DOMException('BroadcastChannel is closed', 'InvalidStateError');
        }

        const cloned = structuredClone(data);
        if (workerRuntime.isWorker) {
            postToParent({ op: 'post', id: this.id, data: cloned });
        } else {
            deliverLocal(this.name, this, cloned);
            deliverRemote(this.name, null, cloned);
        }
    }

    close(): void {
        if (!this.#closed) {
            this.#closed = true;
            channelById.delete(this.id);
            const peers = channels.get(this.name);
            peers?.delete(this);
            if (peers?.size === 0) channels.delete(this.name);
            if (workerRuntime.isWorker) {
                postToParent({ op: 'unsubscribe', id: this.id });
            }
            this.dispatchEvent(new Event('close', { bubbles: false, cancelable: false }));
        }
    }

    dispatchBroadcastMessage(data: unknown): void {
        queueMicrotask(() => {
            if (this.#closed) return;
            this.dispatchEvent(new MessageEvent('message', {
                data,
                bubbles: false,
                cancelable: false
            }, true));
        });
    }

    addEventListener(type: string, handler: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions): void {
        super.addEventListener(type, handler, options);
    }

    removeEventListener(type: string, handler: EventListenerOrEventListenerObject | null, options?: EventListenerOptions): void {
        super.removeEventListener(type, handler, options);
    }

    #onmessage: BroadcastChannelHandler | null = null;
    #onmessageListener: EventListener | null = null;
    get onmessage(): BroadcastChannelHandler | null {
        return this.#onmessage;
    }
    set onmessage(handler: BroadcastChannelHandler | null) {
        if (this.#onmessageListener) {
            this.removeEventListener('message', this.#onmessageListener);
            this.#onmessageListener = null;
        }
        this.#onmessage = typeof handler === 'function' ? handler : null;
        if (this.#onmessage) {
            this.#onmessageListener = (event) => {
                if (event instanceof MessageEvent) this.#onmessage?.call(this, event);
            };
            this.addEventListener('message', this.#onmessageListener);
        }
    }

    #onmessageerror: BroadcastChannelHandler | null = null;
    #onmessageerrorListener: EventListener | null = null;
    get onmessageerror(): BroadcastChannelHandler | null {
        return this.#onmessageerror;
    }
    set onmessageerror(handler: BroadcastChannelHandler | null) {
        if (this.#onmessageerrorListener) {
            this.removeEventListener('messageerror', this.#onmessageerrorListener);
            this.#onmessageerrorListener = null;
        }
        this.#onmessageerror = typeof handler === 'function' ? handler : null;
        if (this.#onmessageerror) {
            this.#onmessageerrorListener = (event) => {
                if (event instanceof MessageEvent) this.#onmessageerror?.call(this, event);
            };
            this.addEventListener('messageerror', this.#onmessageerrorListener);
        }
    }

    ref(): this {
        return this;
    }

    unref(): this {
        return this;
    }
}

globalThis.BroadcastChannel = BroadcastChannelImpl;
