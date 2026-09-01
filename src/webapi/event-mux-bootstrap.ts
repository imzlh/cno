type EventContext = { handled: boolean; dispatched: boolean };
type EventReceiver = (eventName: number, eventData: unknown, ctx: EventContext) => boolean | undefined;

interface EventMuxModule {
    WEBAPI_ROLE: string;
    PRIORITY_WEBAPI: number;
    installEventReceiver(role: string, receiver: EventReceiver, priority?: number): () => void;
}

type MuxLoader = () => Promise<EventMuxModule>;

const MUX_SPECIFIER = '../../../cts/src/runtime/event-mux';
const MUX_SLOT = Symbol.for('cno.engine.eventMux.v1');

function hasMuxRegistry(): boolean {
    return Reflect.get(globalThis, MUX_SLOT) != null;
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

/** Install through CTS when present; raw onEvent is only safe without that layer. */
export async function installWebApiEventReceiver(
    receiver: EventReceiver,
    installStandalone: () => void,
    loadMux: MuxLoader = loadMuxModule,
): Promise<void> {
    let mux: EventMuxModule;
    try {
        mux = await loadMux();
    } catch (error) {
        if (!isMissingMuxModule(error) || hasMuxRegistry()) throw error;
        installStandalone();
        return;
    }

    // Do not fall back after this point: onEvent() would replace the mux slot.
    mux.installEventReceiver(mux.WEBAPI_ROLE, receiver, mux.PRIORITY_WEBAPI);
}
