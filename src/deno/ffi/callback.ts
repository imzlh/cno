/**
 * Deno-compatible same-thread unsafe callbacks.
 */

import { errors } from '../01_errors';
import { createPointerObject } from './pointer';
import {
    fromFfiValue,
    toFfiCallbackResult,
    toFfiFunctionSignature,
} from './utils';

const ffi = import.meta.use('ffi');
const createCallback = ffi.callback as unknown as (
    signature: CModuleFFI.FunctionSignature,
    callback: (...args: unknown[]) => unknown,
) => CModuleFFI.Callback;

interface CallbackInternal {
    closure: CModuleFFI.Callback;
    refCount: number;
    closed: boolean;
}

/**
 * A synchronous JavaScript callback exposed as a native function pointer.
 *
 * Native code may invoke the callback only on the thread where it was created.
 * Cross-thread callbacks are unsupported and never enter the JavaScript runtime.
 */
export class UnsafeCallback<
    const Definition extends Deno.UnsafeCallbackDefinition = Deno.UnsafeCallbackDefinition,
> {
    readonly pointer: Deno.PointerObject<Definition>;
    readonly definition: Definition;
    readonly callback: Deno.UnsafeCallbackFunction<
        Definition['parameters'],
        Definition['result']
    >;

    private internal: CallbackInternal;
    /** Bounded keepalive for pointer-like results; a native caller holding a
     * result older than the limit is already outside Deno's call-duration
     * contract, so dropping the oldest entry cannot extend a live object. */
    private resultOwners = new Set<unknown>();
    private static readonly RESULT_OWNER_LIMIT = 64;

    constructor(
        definition: Definition,
        callback: Deno.UnsafeCallbackFunction<
            Definition['parameters'],
            Definition['result']
        >,
    ) {
        this.definition = definition;
        this.callback = callback;

        const signature = toFfiFunctionSignature(definition.parameters, definition.result);
        const closure = createCallback(signature, (...args: unknown[]) => {
            const convertedArgs = args.map((arg, index) =>
                fromFfiValue(arg, definition.parameters[index], createPointerObject)
            );
            const result = Reflect.apply(callback, null, convertedArgs);
            const ffiResult = toFfiCallbackResult(result, definition.result);
            if (
                !this.internal.closed &&
                result !== null &&
                (definition.result === 'pointer' ||
                    definition.result === 'function' ||
                    definition.result === 'buffer')
            ) {
                this.resultOwners.add(result);
                // Sets iterate in insertion order: the oldest result is dropped first.
                if (this.resultOwners.size > UnsafeCallback.RESULT_OWNER_LIMIT) {
                    const oldest = this.resultOwners.values().next().value;
                    if (oldest !== undefined) this.resultOwners.delete(oldest);
                }
            }
            return ffiResult as never;
        });

        this.pointer = createPointerObject<Definition>(closure.pointer);
        this.internal = {
            closure,
            refCount: 0,
            closed: false,
        };
    }

    /**
     * Thread-safe callbacks are unsupported.
     *
     * This compatibility entry point always throws `Deno.errors.NotSupported`.
     * Use the constructor for a synchronous, same-thread callback.
     */
    static threadSafe<
        Definition extends Deno.UnsafeCallbackDefinition = Deno.UnsafeCallbackDefinition,
    >(
        _definition: Definition,
        _callback: Deno.UnsafeCallbackFunction<
            Definition['parameters'],
            Definition['result']
        >,
    ): UnsafeCallback<Definition> {
        throw new errors.NotSupported('Thread-safe FFI callbacks are not supported');
    }

    /**
     * Increment and return the compatibility reference count.
     * This does not enable cross-thread callbacks or change event-loop behavior.
     */
    ref(): number {
        if (this.internal.closed) throw new Error('Callback is closed');
        return ++this.internal.refCount;
    }

    /**
     * Decrement and return the compatibility reference count.
     * This does not enable cross-thread callbacks or change event-loop behavior.
     */
    unref(): number {
        if (this.internal.closed) return 0;
        this.internal.refCount = Math.max(0, this.internal.refCount - 1);
        return this.internal.refCount;
    }

    close(): void {
        if (this.internal.closed) return;
        this.internal.closed = true;
        this.internal.refCount = 0;
        this.internal.closure.close();
        this.resultOwners.clear();
    }
}
