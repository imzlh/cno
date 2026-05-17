/**
 * Node.js zlib 模块
 * 基于 CModuleZLib 实现
 */

const zlib = import.meta.use('zlib');

// ============================================================================
// 常量导出
// ============================================================================

// Compression Levels
export const NO_COMPRESSION = zlib.NO_COMPRESSION;
export const BEST_SPEED = zlib.BEST_SPEED;
export const BEST_COMPRESSION = zlib.BEST_COMPRESSION;
export const DEFAULT_COMPRESSION = zlib.DEFAULT_COMPRESSION;

// Compression Strategies
export const DEFAULT_STRATEGY = zlib.DEFAULT_STRATEGY;
export const FILTERED = zlib.FILTERED;
export const HUFFMAN_ONLY = zlib.HUFFMAN_ONLY;
export const RLE = zlib.RLE;
export const FIXED = zlib.FIXED;

// Flush Modes
export const NO_FLUSH = zlib.NO_FLUSH;
export const PARTIAL_FLUSH = zlib.PARTIAL_FLUSH;
export const SYNC_FLUSH = zlib.SYNC_FLUSH;
export const FULL_FLUSH = zlib.FULL_FLUSH;
export const FINISH = zlib.FINISH;
export const BLOCK = zlib.BLOCK;

// ============================================================================
// 类型定义
// ============================================================================

export interface ZlibOptions {
    flush?: number;
    finishFlush?: number;
    chunkSize?: number;
    level?: number;
    strategy?: number;
    memLevel?: number;
    windowBits?: number;
    dictionary?: ArrayBuffer | Uint8Array;
    info?: boolean;
    maxOutputLength?: number;
}

export interface BrotliOptions {
    flush?: number;
    finishFlush?: number;
    chunkSize?: number;
    params?: Record<string, number>;
    maxOutputLength?: number;
}

export type CompressCallback = (err: Error | null, result?: Uint8Array) => void;

// ============================================================================
// 内部辅助函数
// ============================================================================

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
    return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

// ============================================================================
// 同步压缩/解压
// ============================================================================

export function deflateSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return new Uint8Array(zlib.deflate(buffer, level));
}

export function deflateRawSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return new Uint8Array(zlib.deflateRaw(buffer, level));
}

export function gzipSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    const level = options?.level ?? zlib.DEFAULT_COMPRESSION;
    return new Uint8Array(zlib.gzip(buffer, level));
}

export function inflateSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    return new Uint8Array(zlib.inflate(buffer));
}

export function inflateRawSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    return new Uint8Array(zlib.inflateRaw(buffer));
}

export function gunzipSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    return new Uint8Array(zlib.gunzip(buffer));
}

export function unzipSync(buffer: ArrayBuffer | Uint8Array, options?: ZlibOptions): Uint8Array {
    const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    // Auto-detect format by magic number
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
        return new Uint8Array(zlib.gunzip(buffer));
    }
    if (buf[0] === 0x78 && (buf[1] === 0x01 || buf[1] === 0x5e || buf[1] === 0x9c || buf[1] === 0xda)) {
        return new Uint8Array(zlib.inflate(buffer));
    }
    // Try gunzip first, then inflate
    try { return new Uint8Array(zlib.gunzip(buffer)); } catch {}
    return new Uint8Array(zlib.inflate(buffer));
}

// ============================================================================
// 异步压缩/解压（回调风格）
// ============================================================================

export function deflate(buffer: ArrayBuffer | Uint8Array, callback: CompressCallback): void;
export function deflate(buffer: ArrayBuffer | Uint8Array, options: ZlibOptions, callback: CompressCallback): void;
export function deflate(buffer: ArrayBuffer | Uint8Array, optionsOrCallback: ZlibOptions | CompressCallback, callback?: CompressCallback): void {
    const opts = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    
    queueMicrotask(() => {
        try {
            const result = deflateSync(buffer, opts);
            cb?.(null, result);
        } catch (err) {
            cb?.(err as Error);
        }
    });
}

export function deflateRaw(buffer: ArrayBuffer | Uint8Array, callback: CompressCallback): void;
export function deflateRaw(buffer: ArrayBuffer | Uint8Array, options: ZlibOptions, callback: CompressCallback): void;
export function deflateRaw(buffer: ArrayBuffer | Uint8Array, optionsOrCallback: ZlibOptions | CompressCallback, callback?: CompressCallback): void {
    const opts = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    
    queueMicrotask(() => {
        try {
            const result = deflateRawSync(buffer, opts);
            cb?.(null, result);
        } catch (err) {
            cb?.(err as Error);
        }
    });
}

export function gzip(buffer: ArrayBuffer | Uint8Array, callback: CompressCallback): void;
export function gzip(buffer: ArrayBuffer | Uint8Array, options: ZlibOptions, callback: CompressCallback): void;
export function gzip(buffer: ArrayBuffer | Uint8Array, optionsOrCallback: ZlibOptions | CompressCallback, callback?: CompressCallback): void {
    const opts = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    
    queueMicrotask(() => {
        try {
            const result = gzipSync(buffer, opts);
            cb?.(null, result);
        } catch (err) {
            cb?.(err as Error);
        }
    });
}

export function inflate(buffer: ArrayBuffer | Uint8Array, callback: CompressCallback): void;
export function inflate(buffer: ArrayBuffer | Uint8Array, options: ZlibOptions, callback: CompressCallback): void;
export function inflate(buffer: ArrayBuffer | Uint8Array, optionsOrCallback: ZlibOptions | CompressCallback, callback?: CompressCallback): void {
    const opts = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    
    queueMicrotask(() => {
        try {
            const result = inflateSync(buffer, opts);
            cb?.(null, result);
        } catch (err) {
            cb?.(err as Error);
        }
    });
}

export function inflateRaw(buffer: ArrayBuffer | Uint8Array, callback: CompressCallback): void;
export function inflateRaw(buffer: ArrayBuffer | Uint8Array, options: ZlibOptions, callback: CompressCallback): void;
export function inflateRaw(buffer: ArrayBuffer | Uint8Array, optionsOrCallback: ZlibOptions | CompressCallback, callback?: CompressCallback): void {
    const opts = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    
    queueMicrotask(() => {
        try {
            const result = inflateRawSync(buffer, opts);
            cb?.(null, result);
        } catch (err) {
            cb?.(err as Error);
        }
    });
}

export function gunzip(buffer: ArrayBuffer | Uint8Array, callback: CompressCallback): void;
export function gunzip(buffer: ArrayBuffer | Uint8Array, options: ZlibOptions, callback: CompressCallback): void;
export function gunzip(buffer: ArrayBuffer | Uint8Array, optionsOrCallback: ZlibOptions | CompressCallback, callback?: CompressCallback): void {
    const opts = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    
    queueMicrotask(() => {
        try {
            const result = gunzipSync(buffer, opts);
            cb?.(null, result);
        } catch (err) {
            cb?.(err as Error);
        }
    });
}

export function unzip(buffer: ArrayBuffer | Uint8Array, callback: CompressCallback): void;
export function unzip(buffer: ArrayBuffer | Uint8Array, options: ZlibOptions, callback: CompressCallback): void;
export function unzip(buffer: ArrayBuffer | Uint8Array, optionsOrCallback: ZlibOptions | CompressCallback, callback?: CompressCallback): void {
    const opts = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    
    queueMicrotask(() => {
        try {
            const result = unzipSync(buffer, opts);
            cb?.(null, result);
        } catch (err) {
            cb?.(err as Error);
        }
    });
}

// ============================================================================
// 流式压缩/解压
// ============================================================================

import { Transform, TransformOptions } from '../stream';

export class Deflate extends Transform {
    private _handle: CModuleZLib.Deflate;
    
    constructor(options?: ZlibOptions & TransformOptions) {
        super(options);
        this._handle = zlib.createDeflate(
            options?.level ?? zlib.DEFAULT_COMPRESSION,
            options?.strategy ?? zlib.DEFAULT_STRATEGY,
            options?.memLevel ?? 8
        );
    }
    
    protected _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        try {
            const input = toUint8Array(chunk);
            const output = this._handle.deflate(input);
            callback(null, new Uint8Array(output));
        } catch (err) {
            callback(err as Error);
        }
    }
    
    protected _flush(callback: (error?: Error | null, data?: any) => void): void {
        try {
            const output = this._handle.finish();
            callback(null, new Uint8Array(output));
        } catch (err) {
            callback(err as Error);
        }
    }
}

export class Inflate extends Transform {
    private _handle: CModuleZLib.Inflate;
    
    constructor(options?: ZlibOptions & TransformOptions) {
        super(options);
        this._handle = zlib.createInflate();
    }
    
    protected _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        try {
            const input = toUint8Array(chunk);
            const output = this._handle.inflate(input);
            callback(null, new Uint8Array(output));
        } catch (err) {
            callback(err as Error);
        }
    }
}

export class Gzip extends Transform {
    private _handle: CModuleZLib.Deflate;
    
    constructor(options?: ZlibOptions & TransformOptions) {
        super(options);
        this._handle = zlib.createGzip(
            options?.level ?? zlib.DEFAULT_COMPRESSION,
            options?.strategy ?? zlib.DEFAULT_STRATEGY,
            options?.memLevel ?? 8
        );
    }
    
    protected _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        try {
            const input = toUint8Array(chunk);
            const output = this._handle.deflate(input);
            callback(null, new Uint8Array(output));
        } catch (err) {
            callback(err as Error);
        }
    }
    
    protected _flush(callback: (error?: Error | null, data?: any) => void): void {
        try {
            const output = this._handle.finish();
            callback(null, new Uint8Array(output));
        } catch (err) {
            callback(err as Error);
        }
    }
}

export class Gunzip extends Transform {
    private _handle: CModuleZLib.Inflate;
    
    constructor(options?: ZlibOptions & TransformOptions) {
        super(options);
        this._handle = zlib.createGunzip();
    }
    
    protected _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        try {
            const input = toUint8Array(chunk);
            const output = this._handle.inflate(input);
            callback(null, new Uint8Array(output));
        } catch (err) {
            callback(err as Error);
        }
    }
}

export class DeflateRaw extends Transform {
    private _handle: CModuleZLib.Deflate;
    
    constructor(options?: ZlibOptions & TransformOptions) {
        super(options);
        this._handle = zlib.createDeflateRaw(
            options?.level ?? zlib.DEFAULT_COMPRESSION,
            options?.strategy ?? zlib.DEFAULT_STRATEGY,
            options?.memLevel ?? 8
        );
    }
    
    protected _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        try {
            const input = toUint8Array(chunk);
            const output = this._handle.deflate(input);
            callback(null, new Uint8Array(output));
        } catch (err) {
            callback(err as Error);
        }
    }
    
    protected _flush(callback: (error?: Error | null, data?: any) => void): void {
        try {
            const output = this._handle.finish();
            callback(null, new Uint8Array(output));
        } catch (err) {
            callback(err as Error);
        }
    }
}

export class InflateRaw extends Transform {
    private _handle: CModuleZLib.Inflate;
    
    constructor(options?: ZlibOptions & TransformOptions) {
        super(options);
        this._handle = zlib.createInflateRaw();
    }
    
    protected _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        try {
            const input = toUint8Array(chunk);
            const output = this._handle.inflate(input);
            callback(null, new Uint8Array(output));
        } catch (err) {
            callback(err as Error);
        }
    }
}

export class Unzip extends Transform {
    private _handle: CModuleZLib.Inflate;
    
    constructor(options?: ZlibOptions & TransformOptions) {
        super(options);
        this._handle = zlib.createInflate();
    }
    
    protected _transform(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null, data?: any) => void): void {
        try {
            const input = toUint8Array(chunk);
            const output = this._handle.inflate(input);
            callback(null, new Uint8Array(output));
        } catch (err) {
            callback(err as Error);
        }
    }
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createDeflate(options?: ZlibOptions): Deflate {
    // @ts-ignore - options type compatibility
    return new Deflate(options);
}

export function createInflate(options?: ZlibOptions): Inflate {
    // @ts-ignore - options type compatibility
    return new Inflate(options);
}

export function createGzip(options?: ZlibOptions): Gzip {
    // @ts-ignore - options type compatibility
    return new Gzip(options);
}

export function createGunzip(options?: ZlibOptions): Gunzip {
    // @ts-ignore - options type compatibility
    return new Gunzip(options);
}

export function createDeflateRaw(options?: ZlibOptions): DeflateRaw {
    // @ts-ignore - options type compatibility
    return new DeflateRaw(options);
}

export function createInflateRaw(options?: ZlibOptions): InflateRaw {
    // @ts-ignore - options type compatibility
    return new InflateRaw(options);
}

export function createUnzip(options?: ZlibOptions): Unzip {
    // @ts-ignore - options type compatibility
    return new Unzip(options);
}

// ============================================================================
// 校验和
// ============================================================================

export function crc32(data: ArrayBuffer | Uint8Array, value?: number): number {
    return zlib.crc32(data, value);
}

export function adler32(data: ArrayBuffer | Uint8Array, value?: number): number {
    return zlib.adler32(data, value);
}

// ============================================================================
// 常量
// ============================================================================

export const constants = {
    Z_NO_FLUSH: zlib.NO_FLUSH,
    Z_PARTIAL_FLUSH: zlib.PARTIAL_FLUSH,
    Z_SYNC_FLUSH: zlib.SYNC_FLUSH,
    Z_FULL_FLUSH: zlib.FULL_FLUSH,
    Z_FINISH: zlib.FINISH,
    Z_BLOCK: zlib.BLOCK,
    Z_NO_COMPRESSION: zlib.NO_COMPRESSION,
    Z_BEST_SPEED: zlib.BEST_SPEED,
    Z_BEST_COMPRESSION: zlib.BEST_COMPRESSION,
    Z_DEFAULT_COMPRESSION: zlib.DEFAULT_COMPRESSION,
    Z_FILTERED: zlib.FILTERED,
    Z_HUFFMAN_ONLY: zlib.HUFFMAN_ONLY,
    Z_RLE: zlib.RLE,
    Z_FIXED: zlib.FIXED,
    Z_DEFAULT_STRATEGY: zlib.DEFAULT_STRATEGY,
    Z_OK: 0,
    Z_STREAM_END: 1,
    Z_NEED_DICT: 2,
    Z_ERRNO: -1,
    Z_STREAM_ERROR: -2,
    Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4,
    Z_BUF_ERROR: -5,
    Z_VERSION_ERROR: -6,
};