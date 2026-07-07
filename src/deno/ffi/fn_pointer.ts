import {
    FromForeignFunction,
    ForeignFunction,
    PointerObject as LocalPointerObject,
} from './types';
import { callRegisteredCallback } from './callback';

type UnsafeFunctionPointer<Fn extends ForeignFunction> =
    Deno.PointerObject<NoInfer<Omit<Fn, 'nonblocking'>>> & Deno.PointerObject<Fn> & LocalPointerObject;

export class UnsafeFnPointer<const Fn extends ForeignFunction> implements Deno.UnsafeFnPointer<Fn> {
    readonly pointer: Deno.PointerObject<Fn>;
    readonly definition: Fn;
    readonly call: Deno.FromForeignFunction<Fn>;

    constructor(pointer: Deno.PointerObject<NoInfer<Omit<Fn, 'nonblocking'>>>, definition: Fn);
    constructor(pointer: UnsafeFunctionPointer<Fn>, definition: Fn) {
        const localPointer: LocalPointerObject = pointer;

        this.pointer = pointer;
        this.definition = definition;
        const call: FromForeignFunction<Fn> = ((...args: readonly unknown[]) => {
            const called = callRegisteredCallback(localPointer, args);
            if (!called.found) {
                throw new TypeError('UnsafeFnPointer can only call registered UnsafeCallback pointers');
            }
            if (this.definition.nonblocking) {
                return Promise.resolve(called.value);
            }
            return called.value;
        }) as FromForeignFunction<Fn>;
        this.call = call as Deno.FromForeignFunction<Fn>;
    }
}
