import { Buffer } from 'node:buffer';
import type { LibdeflateCompressionOptions, ZlibCompressionOptions } from 'bun';

const zlib = import.meta.use('zlib');

export type CompressionInput = string | ArrayBuffer | ArrayBufferView;

export type { LibdeflateCompressionOptions, ZlibCompressionOptions };

export type CompressionOptions = ZlibCompressionOptions | LibdeflateCompressionOptions;

type RuntimeOptions = Record<PropertyKey, unknown>;
type BrandGetter<T> = (this: unknown) => T;
type InflateHandle = {
    inflate(data: Uint8Array, flush?: number): Uint8Array;
    readonly finished: boolean;
};

type InflateFormat = 'raw' | 'zlib' | 'gzip' | 'auto';

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(
    ArrayBuffer.prototype,
    'byteLength',
)!.get! as BrandGetter<number>;
const sharedArrayBufferByteLength = typeof SharedArrayBuffer === 'function'
    ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get as BrandGetter<number> | undefined
    : undefined;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get! as BrandGetter<ArrayBufferLike>;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get! as BrandGetter<number>;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get! as BrandGetter<number>;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get! as BrandGetter<ArrayBufferLike>;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get! as BrandGetter<number>;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get! as BrandGetter<number>;
const stringValueOf = String.prototype.valueOf;
const NumberConstructor = Number;
const StringConstructor = String;
const numberIsNaN = Number.isNaN;
const numberIsFinite = Number.isFinite;
const numberIsInteger = Number.isInteger;
const mathTrunc = Math.trunc;
const mathMax = Math.max;
const mathMin = Math.min;
const objectIs = Object.is;
const arrayBufferIsView = ArrayBuffer.isView;
const emptyBytes = new Uint8Array();

function codedError<T extends Error>(error: T, code: string): T {
    Object.defineProperty(error, 'code', {
        configurable: true,
        value: code,
        writable: true,
    });
    return error;
}

function invalidInput(): TypeError {
    return codedError(
        new TypeError('data must be a string, ArrayBuffer or ArrayBufferView'),
        'ERR_INVALID_ARG_TYPE',
    );
}

function bufferByteLength(value: unknown): number | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    try {
        // Intrinsic getters perform a realm-independent internal-slot check.
        return Reflect.apply(arrayBufferByteLength, value, []);
    } catch {
        if (sharedArrayBufferByteLength === undefined) return undefined;
        try {
            return Reflect.apply(sharedArrayBufferByteLength, value, []);
        } catch {
            return undefined;
        }
    }
}

function boxedString(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    try {
        return Reflect.apply(stringValueOf, value, []);
    } catch {
        return undefined;
    }
}

function validateInput(data: unknown): void {
    if (typeof data === 'string' || boxedString(data) !== undefined) return;
    if (bufferByteLength(data) !== undefined || arrayBufferIsView(data)) return;
    throw invalidInput();
}

function viewBytes(data: ArrayBufferView): { backing: ArrayBufferLike; bytes: Uint8Array } {
    let backing: ArrayBufferLike;
    try {
        backing = Reflect.apply(typedArrayBuffer, data, []);
        const byteOffset = Reflect.apply(typedArrayByteOffset, data, []);
        const byteLength = Reflect.apply(typedArrayByteLength, data, []);
        return { backing, bytes: byteLength === 0 ? emptyBytes : new Uint8Array(backing, byteOffset, byteLength) };
    } catch {
        try {
            backing = Reflect.apply(dataViewBuffer, data, []);
            const byteOffset = Reflect.apply(dataViewByteOffset, data, []);
            const byteLength = Reflect.apply(dataViewByteLength, data, []);
            return { backing, bytes: byteLength === 0 ? emptyBytes : new Uint8Array(backing, byteOffset, byteLength) };
        } catch {
            // Bun treats detached views as empty inputs.
            return { backing: new ArrayBuffer(0), bytes: emptyBytes };
        }
    }
}

function inputBytes(data: unknown, copyShared = false): Uint8Array {
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    const text = boxedString(data);
    if (text !== undefined) return Buffer.from(text, 'utf8');

    const byteLength = bufferByteLength(data);
    if (byteLength !== undefined) {
        if (byteLength === 0) return emptyBytes;
        const bytes = new Uint8Array(data as ArrayBufferLike);
        return copyShared && sharedArrayBufferByteLength !== undefined
                && bufferByteLengthWith(sharedArrayBufferByteLength, data) !== undefined
            ? new Uint8Array(bytes)
            : bytes;
    }

    const view = viewBytes(data as ArrayBufferView);
    return copyShared && sharedArrayBufferByteLength !== undefined
            && bufferByteLengthWith(sharedArrayBufferByteLength, view.backing) !== undefined
        ? new Uint8Array(view.bytes)
        : view.bytes;
}

function bufferByteLengthWith(getter: BrandGetter<number>, value: unknown): number | undefined {
    try {
        return Reflect.apply(getter, value, []);
    } catch {
        return undefined;
    }
}

function optionsObject(options: unknown, operation: 'Compression' | 'Decompression'): RuntimeOptions {
    if (options === undefined) return Object.create(null) as RuntimeOptions;
    if (options === null || (typeof options !== 'object' && typeof options !== 'function')) {
        throw codedError(
            new TypeError(`Zlib${operation}Options must be an object`),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    return options as RuntimeOptions;
}

function validateLibrary(
    value: unknown,
    operation: 'Compression' | 'Decompression',
): 'zlib' | 'libdeflate' {
    if (value == null) return 'zlib';
    const name = typeof value === 'string' ? value : boxedString(value);
    if (name === '' || name === 'zlib') return 'zlib';
    if (name === 'libdeflate') return name;
    if (name === undefined) {
        throw codedError(
            new TypeError(`Zlib${operation}Options.library must be a string`),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    throw codedError(
        new TypeError("Expected library to be one of 'zlib' or 'libdeflate'"),
        'ERR_INVALID_ARG_TYPE',
    );
}

// Bun's zlib level goes through an int32 conversion rather than the strict
// integer validation used by memLevel and strategy.
function compressionLevel(value: unknown, library: 'zlib' | 'libdeflate'): number {
    if (value === undefined) return library === 'zlib' ? -1 : 6;

    let converted = NumberConstructor(value);
    if (numberIsNaN(converted)) converted = 0;
    converted = mathTrunc(converted);

    if (library === 'libdeflate') {
        if (converted >= 0 && converted <= 12) return converted;
        throw codedError(
            new TypeError('Compression level must be between 0 and 12 for libdeflate'),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    if (numberIsFinite(converted) && converted >= -1 && converted <= 9) return converted;
    throw new Error('Zlib error: Invalid argument');
}

function optionInteger(
    value: unknown,
    name: 'memLevel' | 'strategy',
    minimum: number,
    maximum: number,
    fallback: number,
): number {
    if (value === undefined) return fallback;
    const optionName = `ZlibCompressionOptions.${name}`;
    if (typeof value !== 'number') {
        throw codedError(
            new TypeError(`The "${optionName}" property must be of type number. Received ${formatValue(value)}`),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    if (!numberIsInteger(value)) {
        throw codedError(
            new RangeError(`The value of "${optionName}" is out of range. It must be an integer. Received ${formatValue(value)}`),
            'ERR_OUT_OF_RANGE',
        );
    }
    if (value < minimum || value > maximum) {
        throw codedError(
            new RangeError(
                `The value of "${optionName}" is out of range. `
                + `It must be >= ${minimum} && <= ${maximum}. Received ${formatValue(value)}`,
            ),
            'ERR_OUT_OF_RANGE',
        );
    }
    return value;
}

function formatValue(value: unknown): string {
    if (typeof value === 'string') return `type string ('${value}')`;
    if (typeof value === 'boolean') return `type boolean (${value})`;
    if (typeof value === 'bigint') return `type bigint (${value}n)`;
    if (typeof value === 'symbol') return `type symbol (${StringConstructor(value)})`;
    if (objectIs(value, -0)) return '-0';
    return StringConstructor(value);
}

function compress(kind: 'gzip' | 'deflateRaw', data: unknown, options?: unknown): Uint8Array {
    validateInput(data);
    const object = optionsObject(options, 'Compression');

    // Dictionary fields are read and converted one at a time in declaration order.
    const windowBits = object.windowBits;
    if (windowBits !== undefined) NumberConstructor(windowBits);
    const library = validateLibrary(object.library, 'Compression');
    const levelValue = object.level;
    const requestedLevel = compressionLevel(levelValue, library);
    const memLevelValue = object.memLevel;
    const memLevel = optionInteger(memLevelValue, 'memLevel', 1, 9, 8);
    const strategyValue = object.strategy;
    const strategy = optionInteger(strategyValue, 'strategy', 0, 4, zlib.DEFAULT_STRATEGY);
    // Capture bytes only after option access: accessors can detach or mutate the input.
    const input = inputBytes(data, true);

    // zlib's encoder is the portable fallback for Bun's optional libdeflate
    // backend. Level 0 is stored; every positive effort maps to zlib's closest
    // effort level while preserving the same DEFLATE wire format.
    const level = library === 'libdeflate'
        ? requestedLevel === 0 ? 0 : mathMax(1, mathMin(9, requestedLevel))
        : requestedLevel;
    const output = kind === 'gzip'
        ? zlib.gzip(input, level, strategy, memLevel)
        : zlib.deflateRaw(input, level, strategy, memLevel);
    const result = new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
    if (library === 'libdeflate' && kind === 'gzip') {
        // libdeflate identifies the originating system as unknown rather than
        // Unix. Its XFL thresholds also differ from zlib's level-9-only rule.
        result[8] = requestedLevel <= 1 ? 4 : requestedLevel >= 8 ? 2 : 0;
        result[9] = 0xff;
    }
    return result;
}

function toInteger(value: unknown): number {
    const number = NumberConstructor(value);
    return numberIsNaN(number) ? 0 : mathTrunc(number);
}

function decompressionFormat(defaultFormat: 'raw' | 'gzip', bits: number | undefined): InflateFormat {
    if (bits === undefined) return defaultFormat;
    // zlib's inflateInit2() accepts these mode ranges. Values outside them
    // fail at initialization; Bun exposes that as this generic argument error.
    if (bits <= -8 && bits >= -15) return 'raw';
    if (bits === 0 || (bits >= 8 && bits <= 15)) return 'zlib';
    if (bits === 16 || (bits >= 24 && bits <= 31)) return 'gzip';
    if (bits === 32) return 'auto';
    if (bits >= 40 && bits <= 47) return 'auto';
    throw new Error('Zlib error: Invalid argument');
}

function createInflate(format: InflateFormat): InflateHandle {
    switch (format) {
        case 'raw': return zlib.createInflateRaw();
        case 'zlib': return zlib.createInflate();
        case 'gzip': return zlib.createGunzip();
        case 'auto': return zlib.createUnzip();
    }
}

function nativeErrorMessage(error: unknown): string {
    if (typeof error !== 'object' || error === null) return String(error);
    const message = Reflect.get(error, 'message');
    if (typeof message !== 'string') return String(error);
    return message.replace(/^Inflate failed:\s*/, '');
}

function decompress(defaultFormat: 'raw' | 'gzip', data: unknown, options?: unknown): Uint8Array {
    validateInput(data);
    const object = optionsObject(options, 'Decompression');
    const windowBitsValue = object.windowBits;
    const windowBits = windowBitsValue === undefined ? undefined : toInteger(windowBitsValue);
    const levelValue = object.level;
    if (levelValue !== undefined) toInteger(levelValue);
    const memLevelValue = object.memLevel;
    if (memLevelValue !== undefined) toInteger(memLevelValue);
    const strategyValue = object.strategy;
    if (strategyValue !== undefined) toInteger(strategyValue);
    validateLibrary(object.library, 'Decompression');
    const format = decompressionFormat(defaultFormat, windowBits);
    const input = inputBytes(data);
    const handle = createInflate(format);

    let output: Uint8Array;
    try {
        output = handle.inflate(input, zlib.NO_FLUSH);
    } catch (error) {
        throw new Error(nativeErrorMessage(error));
    }
    // Seeing the stream trailer is mandatory. Native handles deliberately
    // expose partial output for incremental use, while Bun's one-shot helpers
    // reject empty and truncated streams.
    if (handle.finished !== true) throw new Error('Zlib returned an error');
    return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
}

export const gzipSync = (data: CompressionInput, options: CompressionOptions | undefined = undefined): Uint8Array<ArrayBuffer> =>
    compress('gzip', data, options) as Uint8Array<ArrayBuffer>;

export const gunzipSync = (data: CompressionInput, options: CompressionOptions | undefined = undefined): Uint8Array<ArrayBuffer> =>
    decompress('gzip', data, options) as Uint8Array<ArrayBuffer>;

export const deflateSync = (data: CompressionInput, options: CompressionOptions | undefined = undefined): Uint8Array<ArrayBuffer> =>
    compress('deflateRaw', data, options) as Uint8Array<ArrayBuffer>;

export const inflateSync = (data: CompressionInput, options: CompressionOptions | undefined = undefined): Uint8Array<ArrayBuffer> =>
    decompress('raw', data, options) as Uint8Array<ArrayBuffer>;
