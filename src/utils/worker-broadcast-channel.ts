import { createPipeRefLease, type PipeRefLease } from './worker-pipe-ref';

type BroadcastOp = 'subscribe' | 'unsubscribe' | 'post' | 'deliver';
type BroadcastPayload = { op: BroadcastOp; id: string; name?: string; data?: unknown };
type BroadcastEnvelope = { __cno_broadcast: BroadcastPayload };
type RemoteBroadcastChannel = { pipe: CModuleWorker.MessagePipe; id: string; name: string };

export type BroadcastChannelBridge = {
    readonly id: string;
    readonly name: string;
    readonly pipe: CModuleWorker.MessagePipe | undefined;
    post(data: unknown): void;
    close(): void;
    ref(): void;
    unref(): void;
};

type LocalBroadcastChannel = {
    bridge: BroadcastChannelBridgeImpl;
    dispatch(data: unknown): void;
    onClose(): void;
};

const workerRuntime = import.meta.use('worker');
const evbus = import.meta.use('evbus');
const BROADCAST_CHANNELS_KEY = 'workerBroadcastChannels';

type BroadcastChannelRegistry = {
    channels: Map<string, Set<LocalBroadcastChannel>>;
    channelById: Map<string, LocalBroadcastChannel>;
    remoteByName: Map<string, Set<RemoteBroadcastChannel>>;
    remoteByPipe: Map<CModuleWorker.MessagePipe, Set<RemoteBroadcastChannel>>;
    nextChannelId: number;
};

const existingRegistry = evbus.get<BroadcastChannelRegistry>('cno.runtime', BROADCAST_CHANNELS_KEY);
const registry = existingRegistry ?? {
    channels: new Map<string, Set<LocalBroadcastChannel>>(),
    channelById: new Map<string, LocalBroadcastChannel>(),
    remoteByName: new Map<string, Set<RemoteBroadcastChannel>>(),
    remoteByPipe: new Map<CModuleWorker.MessagePipe, Set<RemoteBroadcastChannel>>(),
    nextChannelId: 0,
};
if (!existingRegistry) evbus.set('cno.runtime', BROADCAST_CHANNELS_KEY, registry);
const { channels, channelById, remoteByName, remoteByPipe } = registry;

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function isBroadcastEnvelope(value: unknown): value is BroadcastEnvelope {
    return isRecord(value) && isRecord(value.__cno_broadcast);
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
    for (const remote of remoteByPipe.get(pipe) ?? []) if (remote.id === id) return remote;
    return null;
}

function postToRemote(remote: RemoteBroadcastChannel, data: unknown): void {
    remote.pipe.postMessage({ __cno_broadcast: { op: 'deliver', id: remote.id, data: structuredClone(data) } });
}

function deliverLocal(name: string, source: BroadcastChannelBridgeImpl | null, data: unknown): void {
    for (const peer of channels.get(name) ?? []) {
        if (peer.bridge === source || peer.bridge.closed) continue;
        peer.dispatch(structuredClone(data));
    }
}

function deliverRemote(name: string, source: RemoteBroadcastChannel | null, data: unknown): void {
    for (const remote of remoteByName.get(name) ?? []) {
        if (source && remote.pipe === source.pipe && remote.id === source.id) continue;
        postToRemote(remote, data);
    }
}

function postToParent(payload: BroadcastPayload): void {
    workerRuntime.pipe?.postMessage({ __cno_broadcast: payload });
}

class BroadcastChannelBridgeImpl implements BroadcastChannelBridge {
    readonly id = `bc-${++registry.nextChannelId}`;
    readonly name: string;
    readonly pipe = workerRuntime.isWorker ? workerRuntime.pipe : undefined;
    readonly #lease: PipeRefLease | undefined = this.pipe ? createPipeRefLease(this.pipe) : undefined;
    #closed = false;
    #local: LocalBroadcastChannel;

    constructor(name: string, dispatch: (data: unknown) => void, onClose: () => void) {
        this.name = String(name);
        this.#local = { bridge: this, dispatch, onClose };
        channelById.set(this.id, this.#local);
        let peers = channels.get(this.name);
        if (!peers) {
            peers = new Set();
            channels.set(this.name, peers);
        }
        peers.add(this.#local);
        try {
            if (this.pipe) postToParent({ op: 'subscribe', id: this.id, name: this.name });
        } catch (error) {
            this.removeLocal();
            this.#lease?.release();
            throw error;
        }
    }

    get closed(): boolean { return this.#closed; }

    post(data: unknown): void {
        if (this.#closed) return;
        if (this.pipe) postToParent({ op: 'post', id: this.id, data });
        else {
            deliverLocal(this.name, this, data);
            deliverRemote(this.name, null, data);
        }
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.removeLocal();
        try {
            if (this.pipe) postToParent({ op: 'unsubscribe', id: this.id });
        } catch {
            // Closing the local channel still completes after pipe teardown.
        } finally {
            this.#lease?.release();
            this.#local.onClose();
        }
    }

    ref(): void { if (!this.#closed) this.#lease?.ref(); }
    unref(): void { if (!this.#closed) this.#lease?.unref(); }

    private removeLocal(): void {
        channelById.delete(this.id);
        const peers = channels.get(this.name);
        peers?.delete(this.#local);
        if (peers?.size === 0) channels.delete(this.name);
    }
}

export function createBroadcastChannelBridge(
    name: string,
    dispatch: (data: unknown) => void,
    onClose: () => void,
): BroadcastChannelBridge {
    return new BroadcastChannelBridgeImpl(name, dispatch, onClose);
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
    if (channel && !channel.bridge.closed) channel.dispatch(payload.data);
    return true;
}

export function detachWorkerBroadcastPipe(pipe: CModuleWorker.MessagePipe): void {
    for (const remote of Array.from(remoteByPipe.get(pipe) ?? [])) removeRemote(remote);
    let failure: { error: unknown } | undefined;
    for (const channel of Array.from(channelById.values())) {
        if (channel.bridge.pipe !== pipe) continue;
        try { channel.bridge.close(); } catch (error) { failure ??= { error }; }
    }
    if (failure) throw failure.error;
}
