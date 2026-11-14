const ffi = import.meta.use('ffi');

import { errors } from '../01_errors';
import { createPointerObject } from './pointer';
import {
    fromFfiValue,
    isForeignFunction,
    isForeignStatic,
    toFfiArgument,
    toFfiLibrarySignature,
    toFfiReadableType,
} from './utils';
import { toFsPath } from '../../utils/path';

const nativeTypes = new Set([
    'u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64',
    'f32', 'f64', 'bool', 'pointer', 'buffer', 'function', 'usize', 'isize',
]);

function validateNativeType(type: unknown, allowVoid: boolean): void {
    if (type === 'void') {
        if (allowVoid) return;
        throw new TypeError('Invalid native type: void');
    }
    if (typeof type === 'string') {
        if (!nativeTypes.has(type)) throw new TypeError(`Invalid native type: ${type}`);
        return;
    }
    if (type && typeof type === 'object' && 'struct' in type) {
        const members = Reflect.get(type, 'struct');
        if (!Array.isArray(members)) throw new TypeError('Invalid native struct type');
        if (members.length === 0) throw new TypeError('Native struct type must contain at least one member');
        for (const member of members) validateNativeType(member, false);
        return;
    }
    throw new TypeError(`Invalid native type: ${String(type)}`);
}

function validateForeignLibraryInterface(symbols: unknown): asserts symbols is Deno.ForeignLibraryInterface {
    if (symbols === null || typeof symbols !== 'object') {
        throw new TypeError('DynamicLibrary symbols must be an object');
    }
    for (const sym of Object.values(symbols)) {
        if (sym === null || typeof sym !== 'object') {
            throw new TypeError('ForeignFunction or ForeignStatic must be an object');
        }
        if ('parameters' in sym) {
            const name = Reflect.get(sym, 'name');
            if (name !== undefined && typeof name !== 'string') {
                throw new TypeError('ForeignFunction name must be a string');
            }
            const parameters = Reflect.get(sym, 'parameters');
            if (!Array.isArray(parameters)) throw new TypeError('ForeignFunction parameters must be an array');
            for (const type of parameters) validateNativeType(type, false);
            validateNativeType(Reflect.get(sym, 'result'), true);
            const nonblocking = Reflect.get(sym, 'nonblocking');
            if (nonblocking !== undefined && typeof nonblocking !== 'boolean') {
                throw new TypeError('ForeignFunction nonblocking must be a boolean');
            }
            const optional = Reflect.get(sym, 'optional');
            if (optional !== undefined && typeof optional !== 'boolean') {
                throw new TypeError('ForeignFunction optional must be a boolean');
            }
            continue;
        }
        if ('type' in sym) {
            const name = Reflect.get(sym, 'name');
            if (name !== undefined && typeof name !== 'string') {
                throw new TypeError('ForeignStatic name must be a string');
            }
            validateNativeType(Reflect.get(sym, 'type'), false);
            const optional = Reflect.get(sym, 'optional');
            if (optional !== undefined && typeof optional !== 'boolean') {
                throw new TypeError('ForeignStatic optional must be a boolean');
            }
            continue;
        }
        throw new TypeError('Invalid foreign symbol definition');
    }
}

class DynamicLibrary<S extends Deno.ForeignLibraryInterface> implements Deno.DynamicLibrary<S> {
    private lib: CModuleFFI.Library;
    private _symbols: Deno.StaticForeignLibraryInterface<S>;
    private closed = false;

    get symbols(): Deno.StaticForeignLibraryInterface<S> {
        return this._symbols;
    }

    constructor(filename: string | URL, symbolsDef: S) {
        this.lib = ffi.open(toFsPath(filename));
        try {
            this._symbols = this.createSymbols(symbolsDef);
        } catch (error) {
            this.lib.close();
            throw error;
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.lib.close();
    }

    private createSymbols(definitions: S): Deno.StaticForeignLibraryInterface<S> {
        const result: Partial<Record<keyof S, unknown>> = {};

        for (const [name, definition] of Object.entries(definitions)) {
            const symbolName = definition.name ?? name;
            const key = name as keyof S;

            try {
                if (isForeignFunction(definition)) {
                    result[key] = this.createFunction(symbolName, definition);
                } else if (isForeignStatic(definition)) {
                    result[key] = this.createStatic(symbolName, definition);
                }
            } catch (error) {
                // The native binding reports lookup failures as ReferenceError.
                // Optional symbols suppress only that failure; an invalid ABI
                // descriptor or an allocation failure must remain observable.
                if (definition.optional && error instanceof ReferenceError) {
                    result[key] = null;
                } else {
                    throw error;
                }
            }
        }

        return result as Deno.StaticForeignLibraryInterface<S>;
    }

    private createFunction(symbol: string, definition: Deno.ForeignFunction): (...args: unknown[]) => unknown {
        const signature = toFfiLibrarySignature(symbol, definition.parameters, definition.result);
        const bound = this.lib.bind(signature) as (...args: unknown[]) => unknown;

        if (definition.nonblocking) {
            return (): Promise<never> => {
                if (this.closed) return Promise.reject(new Error('Library is closed'));
                return Promise.reject(new errors.NotSupported('Nonblocking FFI calls are not supported'));
            };
        }

        return (...args: unknown[]): unknown => {
            if (this.closed) throw new Error('Library is closed');
            if (args.length !== definition.parameters.length) {
                throw new RangeError(`Expected ${definition.parameters.length} arguments but got ${args.length}`);
            }
            const ffiArgs = args.map((arg, index) => toFfiArgument(arg, definition.parameters[index]));
            return fromFfiValue(bound(...ffiArgs), definition.result, createPointerObject);
        };
    }

    private createStatic(symbol: string, definition: Deno.ForeignStatic): unknown {
        const type = toFfiReadableType(definition.type);
        const value = this.lib.read([type, symbol]);
        return fromFfiValue(value, definition.type, createPointerObject);
    }
}

export function dlopen<const S extends Deno.ForeignLibraryInterface>(
    filename: string | URL,
    symbols: S,
): Deno.DynamicLibrary<S> {
    validateForeignLibraryInterface(symbols);
    return new DynamicLibrary(filename, symbols);
}

export { DynamicLibrary };
