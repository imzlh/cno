import { Buffer } from '../../node/buffer';

const zlib = import.meta.use('zlib');

export type CompressionInput = string | ArrayBuffer | ArrayBufferView;

export interface ZlibCompressionOptions {
    level?: number;
    memLevel?: number;
    windowBits?: number;
    strategy?: number;
    library?: 'zlib';
}

export interface LibdeflateCompressionOptions {
    level?: number;
    library?: 'libdeflate';
}

export type CompressionOptions = ZlibCompressionOptions | LibdeflateCompressionOptions;

type RuntimeOptions = Record<PropertyKey, unknown>;
type InflateHandle = {
    inflate(data: Uint8Array, flush?: number): Uint8Array;
    readonly finished: boolean;
};

type InflateFormat = 'raw' | 'zlib' | 'gzip' | 'auto';

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

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
    return typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer;
}

function inputBytes(data: unknown): Uint8Array {
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    if (data instanceof ArrayBuffer || isSharedArrayBuffer(data)) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw invalidInput();
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
    if (value == null || value === 'zlib') return 'zlib';
    if (value === 'libdeflate') return value;
    if (typeof value !== 'string') {
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

    let converted = Number(value);
    if (Number.isNaN(converted)) converted = 0;
    converted = Math.trunc(converted);

    if (library === 'libdeflate') {
        if (converted >= 0 && converted <= 12) return converted;
        throw codedError(
            new TypeError('Compression level must be between 0 and 12 for libdeflate'),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    if (Number.isFinite(converted) && converted >= -1 && converted <= 9) return converted;
    throw new Error('Zlib error: Invalid argument');
}

function optionInteger(
    options: RuntimeOptions,
    name: 'memLevel' | 'strategy',
    minimum: number,
    maximum: number,
    fallback: number,
): number {
    const value = options[name];
    if (value === undefined) return fallback;
    const optionName = `ZlibCompressionOptions.${name}`;
    if (typeof value !== 'number') {
        throw codedError(
            new TypeError(`The "${optionName}" property must be of type number. Received ${formatValue(value)}`),
            'ERR_INVALID_ARG_TYPE',
        );
    }
    if (!Number.isInteger(value)) {
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
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'symbol') return `type symbol (${String(value)})`;
    if (Object.is(value, -0)) return '-0';
    return String(value);
}

function compress(kind: 'gzip' | 'deflateRaw', data: unknown, options?: unknown): Uint8Array {
    const input = inputBytes(data);
    const object = optionsObject(options, 'Compression');

    // Keep Bun's observable conversion order for accessors and proxies. The
    // compressor currently ignores windowBits, but Bun still converts it.
    const windowBits = object.windowBits;
    const libraryValue = object.library;
    const levelValue = object.level;
    const memLevelValue = object.memLevel;
    const strategyValue = object.strategy;
    if (windowBits !== undefined) Number(windowBits);
    const library = validateLibrary(libraryValue, 'Compression');
    const requestedLevel = compressionLevel(levelValue, library);

    let strategy = zlib.DEFAULT_STRATEGY;
    let memLevel = 8;
    const values: RuntimeOptions = { memLevel: memLevelValue, strategy: strategyValue };
    memLevel = optionInteger(values, 'memLevel', 1, 9, 8);
    strategy = optionInteger(values, 'strategy', 0, 4, zlib.DEFAULT_STRATEGY);

    // zlib's encoder is the portable fallback for Bun's optional libdeflate
    // backend. Level 0 is stored; every positive effort maps to zlib's closest
    // effort level while preserving the same DEFLATE wire format.
    const level = library === 'libdeflate'
        ? requestedLevel === 0 ? 0 : Math.max(1, Math.min(9, requestedLevel))
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
    const number = Number(value);
    return Number.isNaN(number) ? 0 : Math.trunc(number);
}

function decompressionFormat(defaultFormat: 'raw' | 'gzip', value: unknown): InflateFormat {
    if (value === undefined) return defaultFormat;
    const bits = toInteger(value);
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
    const input = inputBytes(data);
    const object = optionsObject(options, 'Decompression');
    const windowBits = object.windowBits;
    const level = object.level;
    const memLevel = object.memLevel;
    const strategy = object.strategy;
    const library = object.library;
    if (level !== undefined) toInteger(level);
    if (memLevel !== undefined) toInteger(memLevel);
    if (strategy !== undefined) toInteger(strategy);
    validateLibrary(library, 'Decompression');
    const format = decompressionFormat(defaultFormat, windowBits);
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

export function gzipSync(data: CompressionInput, options?: CompressionOptions): Uint8Array<ArrayBuffer> {
    return compress('gzip', data, options) as Uint8Array<ArrayBuffer>;
}

export function gunzipSync(data: CompressionInput, options?: CompressionOptions): Uint8Array<ArrayBuffer> {
    return decompress('gzip', data, options) as Uint8Array<ArrayBuffer>;
}

export function deflateSync(data: CompressionInput, options?: CompressionOptions): Uint8Array<ArrayBuffer> {
    return compress('deflateRaw', data, options) as Uint8Array<ArrayBuffer>;
}

export function inflateSync(data: CompressionInput, options?: CompressionOptions): Uint8Array<ArrayBuffer> {
    return decompress('raw', data, options) as Uint8Array<ArrayBuffer>;
}
