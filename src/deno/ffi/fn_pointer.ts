import { errors } from '../01_errors';
import { createPointerObject, getNativePointer } from './pointer';
import {
    fromFfiValue,
    toFfiArgument,
    toFfiFunctionSignature,
} from './utils';

const ffi = import.meta.use('ffi');

type UnsafeFunctionPointer<Fn extends Deno.ForeignFunction> =
    Deno.PointerObject<NoInfer<Omit<Fn, 'nonblocking'>>> & Deno.PointerObject<Fn> & Deno.PointerObject;

export class UnsafeFnPointer<const Fn extends Deno.ForeignFunction> implements Deno.UnsafeFnPointer<Fn> {
    readonly pointer: Deno.PointerObject<Fn>;
    readonly definition: Fn;
    readonly call: Deno.FromForeignFunction<Fn>;

    constructor(pointer: Deno.PointerObject<NoInfer<Omit<Fn, 'nonblocking'>>>, definition: Fn);
    constructor(pointer: UnsafeFunctionPointer<Fn>, definition: Fn) {
        this.pointer = pointer;
        this.definition = definition;

        const signature = toFfiFunctionSignature(definition.parameters, definition.result);
        const bound = ffi.function(getNativePointer(pointer)!, signature) as (...args: unknown[]) => unknown;

        const call = definition.nonblocking
            ? (): Promise<never> => Promise.reject(
                new errors.NotSupported('Nonblocking FFI calls are not supported'),
            )
            : (...args: readonly unknown[]): unknown => {
                const ffiArgs = args.map((arg, index) => toFfiArgument(arg, definition.parameters[index]));
                return fromFfiValue(bound(...ffiArgs), definition.result, createPointerObject);
            };

        this.call = call as Deno.FromForeignFunction<Fn>;
    }
}
