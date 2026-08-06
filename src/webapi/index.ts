import { fromError, PromiseRejectionEvent, EventTarget } from './events';

const { onEvent, EventType } = import.meta.use('engine');

// basic polyfills
Object.defineProperties(globalThis, {
    global: {
        value: globalThis,
        writable: true,
        enumerable: true,
        configurable: false
    },
    self: {
        value: globalThis,
        writable: false,
        enumerable: true,
        configurable: false,
    },
    // Deno main thread: globalThis.window is undefined (not an alias of globalThis).
    window: {
        value: undefined,
        writable: true,
        enumerable: true,
        configurable: true,
    },
    name: {
        value: '',
        writable: true,
        enumerable: true,
        configurable: true,
    },
});

await Promise.all([
    import('./console'),
    import('./basic'),
    import('./events'),
]);

await Promise.all([
    import('./streams'),
    import('./url'),
    import('./location'),
    import('./formdata'),
    import('./urlpattern'),
]);

await Promise.all([
    import('./file-reader'),
    import('./image-data'),
]);

// navigator
await import('./navigator');

// abort-signal polyfill
await import('./abort');

// messaging (MessageChannel, MessagePort)
await import('./messaging');

// global event
const globalEvent = new EventTarget();
Reflect.set(globalThis, 'addEventListener', globalEvent.addEventListener.bind(globalEvent));
Reflect.set(globalThis,'removeEventListener', globalEvent.removeEventListener.bind(globalEvent));
Reflect.set(globalThis, 'dispatchEvent', globalEvent.dispatchEvent.bind(globalEvent));

// onload / onunload property bridges (specs/test/load_unload, specs/run/_078_unload)
function defineGlobalHandler(prop: string, type: string): void {
    let handler: ((ev: globalThis.Event) => void) | null = null;
    const wrapper = (ev: globalThis.Event) => { if (handler) handler.call(globalThis, ev); };
    Object.defineProperty(globalThis, prop, {
        get() { return handler; },
        set(fn: unknown) {
            // @ts-ignore - event
            if (handler) globalEvent.removeEventListener(type, wrapper);
            handler = typeof fn === 'function' ? fn as (ev: Event) => void : null;
            // @ts-ignore - event
            if (handler) globalEvent.addEventListener(type, wrapper);
        },
        enumerable: true,
        configurable: true,
    });
}
defineGlobalHandler('onload', 'load');
defineGlobalHandler('onunload', 'unload');
defineGlobalHandler('onbeforeunload', 'beforeunload');

// bridge cjs event
//
// Registered through the shared multiplexer in cts/src/runtime/event-mux.ts
// rather than calling engine.onEvent() directly. onEvent is a single-slot
// setter that frees the previous receiver (circu.js/src/mod_engine.c:871), so
// the direct call here was silently destroyed by the cts diagnostics receiver
// and none of 'load'/'unload'/'unhandledrejection' ever fired.
//
// WEBAPI_ROLE tells the cts compatibility bridge to stand down, so exactly one
// of the two dispatches — in either load order.
type BridgeCtx = { handled: boolean; dispatched: boolean };

/**
 * EV_BEFORE_UNLOAD (circu.js/src/private.h:172, exposed at mod_engine.c:1281).
 *
 * Read from the runtime enum rather than written as `EventType.BEFORE_UNLOAD`:
 * the hand-maintained `types/engine.d.ts` enum still stops at LOAD, and it is
 * duplicated across four submodules. Taking the live value (with the C constant
 * as fallback) cannot drift from the binary the way the declaration has.
 */
const EV_BEFORE_UNLOAD: number = (() => {
    const v = (EventType as unknown as Record<string, unknown>)?.BEFORE_UNLOAD;
    return typeof v === 'number' ? v : 4;
})();

/**
 * Is this runtime a worker? `vm.c:407` defines the global for exactly this kind
 * of check. Deno fires neither 'beforeunload' nor 'unload' inside a worker
 * (OBSERVED), and `tjs__lifecycle_drain` already returns early for is_worker —
 * but worker teardown reaches EV_EXIT by a different route (uv__stop), so the
 * EXIT arm below has to make the same exclusion itself.
 */
function inWorker(): boolean {
    return Reflect.get(globalThis, 'isWorker') === true;
}

function bridgeEvent(
    eventName: number,
    eventData: unknown,
    ctx: BridgeCtx,
): boolean | undefined {
    // Handled ahead of the switch because it must NOT reach the shared tail: the
    // tail returns `undefined`, which the mux turns into defaultReturn(4) ===
    // false — "proceed with teardown" — so a listener's preventDefault() could
    // never cancel. The cancel decision is this event's entire return contract.
    if (eventName === EV_BEFORE_UNLOAD) {
        // cancelable: true is what makes preventDefault() meaningful, and Deno
        // reports cancelable=true on 'beforeunload' / false on 'unload'
        // (OBSERVED).
        const event = new Event('beforeunload', { cancelable: true });

        // No try/catch: a throwing listener must propagate out of the mux so the
        // C sees JS_EXCEPTION (vm.c:852) and reproduces Deno's semantics — rc=1,
        // later listeners skipped, 'unload' never fires. event-mux.ts re-throws
        // for this id alone; every other event still gets containment.
        globalEvent.dispatchEvent(event);

        // POLARITY — this is the hang-risk line. vm.c:863 cancels on an explicit
        // JS `true` and NOTHING else, so:
        //   preventDefault()  -> true  -> one more loop pass, then re-dispatch
        //   anything else     -> false -> teardown proceeds, process exits
        // A listener that merely `return false`s does not cancel under Deno
        // (OBSERVED), and reporting `defaultPrevented` only is what keeps those
        // two apart. Inverting this makes EVERY run re-dispatch forever.
        return event.defaultPrevented;
    }

    let event;
    switch (eventName) {
        case EventType.EXIT:
            // Process exit: fire unload then exit (Deno order approximates).
            //
            // Gated on the main thread. `tjs__lifecycle_drain` declines for
            // is_worker, but a worker still reaches EV_EXIT through uv__stop on
            // terminate/self.close(), and turning that into 'unload'
            // unconditionally leaked a worker-side 'unload' that Deno does not
            // fire (OBSERVED: worker-unload-LEAKED).
            if (!inWorker()) globalEvent.dispatchEvent(new Event('unload'));
            event = new Event('exit');
            break;
        case EventType.JOB_EXCEPTION:
            // NO unconditional preventDefault() here. It used to be needed: the
            // pre-mux tail was `if (event.defaultPrevented) return true; return
            // false;` and utils.c:180 turns `false` into TJS_Stop, so without a
            // pre-cancel a job exception with no listener killed the process.
            // Pre-cancelling forced the `true` branch — a workaround for a
            // shared tail, not a statement about the error.
            //
            // The mux now supplies that `true` itself, per-event, via
            // defaultReturn() (event-mux.ts:104-107), so the pre-cancel is
            // vestigial. What it was NOT vestigial about is `ctx.handled`:
            // pre-cancelling made every job exception look user-handled, and the
            // cts diagnostics receiver skips its log.warn on ctx.handled — so an
            // uncaught async throw printed NOTHING at all (OBSERVED: a throw
            // from setTimeout produced no output and rc=0, where the previous
            // binary printed "Uncaught (in unhandled job exception)").
            //
            // `handled` must mean "user code cancelled the default action". Only
            // a real listener calling preventDefault() may set it, which is what
            // the shared tail below now does.
            event = fromError(eventData);
            break;
        case EventType.UNHANDLED_REJECTION: {
            const [promise, reason] = eventData as CModuleEngine.GlobalEvents[CModuleEngine.EventType.UNHANDLED_REJECTION];
            event = new PromiseRejectionEvent('unhandledrejection', {
                promise,
                reason,
                cancelable: true,
            }, true)
            break;
        }
        case EventType.LOAD:
            event = new Event('load');
            break;
        default:
            return undefined;
    }
    globalEvent.dispatchEvent(event);
    ctx.dispatched = true;

    if (event.defaultPrevented) {
        // A listener called preventDefault(). Tell the diagnostics receiver the
        // default action was cancelled, so it does not print "Uncaught" for an
        // error the program handled.
        //
        // Reached ONLY from a real listener now. The JOB_EXCEPTION arm used to
        // pre-cancel its own event before this line, which made `handled` true
        // on every async throw and silently ate the diagnostic.
        ctx.handled = true;
    }

    // Native return polarity is NOT uniform, and returning `true` here for a
    // cancelled UNHANDLED_REJECTION was backwards: vm.c:242 treats any non-false
    // return as "still unhandled" and raises JS_EXCEPTION, so preventDefault()
    // asked for an abort. Leave the value to the mux, which applies the correct
    // per-event default (false = do not abort for rejections, true = continue
    // for job exceptions).
    return undefined;
}

try {
    const mux = await import('../../../cts/src/runtime/event-mux');
    mux.installEventReceiver(mux.WEBAPI_ROLE, bridgeEvent, mux.PRIORITY_WEBAPI);
} catch {
    // Standalone cno without cts: fall back to the raw single-slot setter. This
    // is the pre-mux behaviour, displacement risk included, but it keeps the
    // web layer functional rather than silently eventless.
    onEvent((eventName: number, eventData: unknown) => {
        const ctx: BridgeCtx = { handled: false, dispatched: false };
        const ret = bridgeEvent(eventName, eventData, ctx);
        // EV_BEFORE_UNLOAD is the one id whose return value this path must carry
        // through: it IS the cancel decision (vm.c:863), and the blanket `false`
        // below would silently convert every preventDefault() into a proceed.
        // `false` remains the safe default when no listener cancelled, so a
        // missing arm degrades to "exit normally" rather than to a hang.
        if (eventName === EV_BEFORE_UNLOAD) return ret === true;
        // Preserve the legacy contract in this path: rejections must not abort.
        return eventName === EventType.JOB_EXCEPTION ? true : false;
    });
}

// worker
await import('./worker');

// headers
const { Headers } = await import('./headers');
Reflect.set(globalThis, 'Headers', Headers);

// fetch & xhr polyfill (CNO secondary wrapping layer)
await import('./fetch');

// sse(EventSource) polyfill (CNO secondary wrapping layer)
await import('./sse');

// websocket (CNO secondary wrapping layer)
await import('./websocket');

// crypto
await import('./crypto');

// performance
await import('./performance');

// wasm
await import('./wasm');

// storage
await import('./storage');

// BroadcastChannel
await import('./broadcast-channel');

// CacheStorage / Cache API
await import('./cache');

// Scheduling API (scheduler.postTask)
const { scheduler } = await import('./scheduler');
Reflect.set(globalThis, 'scheduler', scheduler);

// Intl (partial support)
await import('./intl');

// webtransport (QUIC) — loads always; native gate fails closed in ctor
await import('./webtransport');

// temporal
// const { Temporal } = await import('temporal-polyfill');
// globalThis.Temporal = Temporal;
