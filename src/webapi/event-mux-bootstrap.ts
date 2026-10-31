type EventContext = { handled: boolean; dispatched: boolean };
type EventReceiver = (eventName: number, eventData: unknown, ctx: EventContext) => boolean | undefined;
type NativeReceiver = (eventName: number, eventData: unknown) => boolean;

type Entry = { role: string; fn: EventReceiver; priority: number; seq: number };
type Registry = {
    version: 1;
    entries: Entry[];
    seq: number;
    native: boolean;
    dispatchDepth: number;
    loadFired: boolean;
    unloadFired: boolean;
    nativeReceiver?: NativeReceiver;
    install(role: string, fn: EventReceiver, priority?: number): () => void;
    has(role: string): boolean;
    roles(): string[];
    dispatch: NativeReceiver;
};

interface EventMuxModule {
    WEBAPI_ROLE: string;
    PRIORITY_WEBAPI: number;
    installEventReceiver(role: string, receiver: EventReceiver, priority?: number): () => void;
}

type MuxLoader = () => Promise<EventMuxModule>;

const MUX_SPECIFIER = '../../../cts/src/runtime/event-mux';
const MUX_SLOT = Symbol.for('cno.engine.eventMux.v1');

function hasMuxRegistry(): boolean {
    if (Reflect.get(globalThis, MUX_SLOT) != null) return true;
    try {
        const use = (import.meta as ImportMeta & { use?: (name: string) => unknown }).use;
        const bus = use?.('evbus') as { has?: (namespace: string, key: string) => boolean } | null;
        return bus?.has?.('cno.engine.eventMux.v1', 'state') === true;
    } catch {
        return false;
    }
}

function isMissingMuxModule(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = Reflect.get(error, 'code');
    return (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND')
        && Reflect.get(error, 'url') === new URL(MUX_SPECIFIER, import.meta.url).href;
}

function loadMuxModule(): Promise<EventMuxModule> {
    return import('../../../cts/src/runtime/event-mux');
}

function eventId(name: string, fallback: number): number {
    try {
        const use = (import.meta as ImportMeta & { use?: (name: string) => unknown }).use;
        const engine = use?.('engine') as { EventType?: Record<string, unknown> } | null;
        const id = engine?.EventType?.[name];
        return typeof id === 'number' ? id : fallback;
    } catch {
        return fallback;
    }
}

/** Minimal same-realm registry when CNO is embedded without CTS. */
function createStandaloneMux(): Registry {
    const jobException = eventId('JOB_EXCEPTION', 1);
    const beforeUnload = eventId('BEFORE_UNLOAD', 4);
    const beforeExit = eventId('BEFORE_EXIT', 5);
    const mux: Registry = {
        version: 1, entries: [], seq: 0, native: false, dispatchDepth: 0,
        loadFired: false, unloadFired: false,
        install(role, fn, priority = 0) {
            const index = mux.entries.findIndex((entry) => entry.role === role);
            if (index !== -1) mux.entries.splice(index, 1);
            const entry = { role, fn, priority, seq: mux.seq++ };
            mux.entries.push(entry);
            mux.entries.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
            return () => {
                const index = mux.entries.indexOf(entry);
                if (index !== -1) mux.entries.splice(index, 1);
            };
        },
        has(role) { return mux.entries.some((entry) => entry.role === role); },
        roles() { return mux.entries.map((entry) => entry.role); },
        dispatch(name, data) {
            const ctx: EventContext = { handled: false, dispatched: false };
            let result: boolean | undefined;
            mux.dispatchDepth++;
            try {
                for (const entry of mux.entries.slice()) {
                    let value: boolean | undefined;
                    try {
                        value = entry.fn(name, data, ctx);
                    } catch (error) {
                        if (name === beforeUnload || name === beforeExit) throw error;
                        continue;
                    }
                    if (typeof value === 'boolean') {
                        result = name === beforeUnload ? result === true || value : value;
                    }
                }
                return result ?? (name === jobException);
            } finally {
                mux.dispatchDepth--;
            }
        },
    };
    return mux;
}

/** Install through CTS when present; otherwise retain a shared local registry. */
export async function installWebApiEventReceiver(
    receiver: EventReceiver,
    installStandalone: (dispatch: NativeReceiver) => void,
    loadMux: MuxLoader = loadMuxModule,
): Promise<void> {
    let mux: EventMuxModule;
    try {
        mux = await loadMux();
    } catch (error) {
        if (!isMissingMuxModule(error)) throw error;
        const existing = Reflect.get(globalThis, MUX_SLOT) as Registry | undefined;
        if (existing?.version === 1 && typeof existing.install === 'function') {
            existing.install('webapi', receiver, 100);
            return;
        }
        if (hasMuxRegistry()) throw error;
        const standalone = createStandaloneMux();
        standalone.install('webapi', receiver, 100);
        standalone.nativeReceiver = (name, data) => standalone.dispatch(name, data);
        Reflect.set(globalThis, MUX_SLOT, standalone);
        try {
            installStandalone(standalone.nativeReceiver);
            standalone.native = true;
        } catch (installError) {
            if (Reflect.get(globalThis, MUX_SLOT) === standalone) Reflect.deleteProperty(globalThis, MUX_SLOT);
            throw installError;
        }
        return;
    }

    // Do not fall back after this point: onEvent() would replace the mux slot.
    mux.installEventReceiver(mux.WEBAPI_ROLE, receiver, mux.PRIORITY_WEBAPI);
}
