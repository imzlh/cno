/**
 * Node.js util 模块
 * 实用工具函数
 */

const console = import.meta.use('console');

// ============================================================================
// 类型判断
// ============================================================================

export function isBoolean(value: unknown): value is boolean {
    return typeof value === 'boolean';
}

export function isNull(value: unknown): value is null {
    return value === null;
}

export function isNullOrUndefined(value: unknown): value is null | undefined {
    return value === null || value === undefined;
}

export function isNumber(value: unknown): value is number {
    return typeof value === 'number';
}

export function isString(value: unknown): value is string {
    return typeof value === 'string';
}

export function isSymbol(value: unknown): value is symbol {
    return typeof value === 'symbol';
}

export function isUndefined(value: unknown): value is undefined {
    return value === undefined;
}

export function isObject(value: unknown): value is object {
    return value !== null && typeof value === 'object';
}

export function isError(value: unknown): value is Error {
    return value instanceof Error;
}

export function isFunction(value: unknown): value is Function {
    return typeof value === 'function';
}

export function isRegExp(value: unknown): value is RegExp {
    return value instanceof RegExp;
}

export function isArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

export function isDate(value: unknown): value is Date {
    return value instanceof Date;
}

export function isPrimitive(value: unknown): value is string | number | boolean | null | undefined | symbol | bigint {
    return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

export function isBuffer(value: unknown): value is Uint8Array {
    return value instanceof Uint8Array;
}

// ============================================================================
// 格式化
// ============================================================================

export function format(format?: string, ...args: any[]): string {
    if (format === undefined) {
        return '';
    }

    let result = '';
    let argIndex = 0;
    let i = 0;

    while (i < format.length) {
        if (format[i] === '%' && i + 1 < format.length) {
            const specifier = format[i + 1];
            i += 2;

            switch (specifier) {
                case 's':
                    result += String(args[argIndex++]);
                    break;
                case 'd':
                    result += Number(args[argIndex++]);
                    break;
                case 'i':
                    result += Math.floor(Number(args[argIndex++]));
                    break;
                case 'f':
                    result += parseFloat(args[argIndex++]);
                    break;
                case 'j':
                    try {
                        result += JSON.stringify(args[argIndex++]);
                    } catch {
                        result += '[Circular]';
                    }
                    break;
                case 'o':
                case 'O':
                    result += inspect(args[argIndex++], { depth: specifier === 'O' ? Infinity : 4 });
                    break;
                case '%':
                    result += '%';
                    break;
                default:
                    result += '%' + specifier;
                    break;
            }
        } else {
            result += format[i++];
        }
    }

    // 添加剩余参数
    while (argIndex < args.length) {
        result += ' ' + inspect(args[argIndex++]);
    }

    return result;
}

export function formatWithOptions(inspectOptions: InspectOptions, format?: any): string {
    if (!format) {
        return '';
    }
    return console.inspect(format, {
        colors: inspectOptions.colors,
        depth: inspectOptions.depth ?? undefined,
        showHidden: inspectOptions.showHidden
    });
}

// ============================================================================
// inspect
// ============================================================================

export interface InspectOptions {
    showHidden?: boolean;
    depth?: number | null;
    colors?: boolean;
    customInspect?: boolean;
    showProxy?: boolean;
    maxArrayLength?: number | null;
    maxStringLength?: number | null;
    breakLength?: number;
    compact?: boolean | number;
    sorted?: boolean | ((a: string, b: string) => number);
    getters?: boolean | 'get' | 'set';
    numericSeparator?: boolean;
}

const defaultInspectOptions: InspectOptions = {
    showHidden: false,
    depth: 2,
    colors: false,
    customInspect: true,
    showProxy: false,
    maxArrayLength: 100,
    maxStringLength: 10000,
    breakLength: 80,
    compact: true,
    sorted: false,
    getters: false,
    numericSeparator: false,
};

export function inspect(object: unknown, options?: InspectOptions): string {
    return formatWithOptions(options ?? {}, object);
}

inspect.defaultOptions = defaultInspectOptions;
inspect.custom = Symbol.for('nodejs.util.inspect.custom');

// ============================================================================
// 继承
// ============================================================================

export function inherits(constructor: Function, superConstructor: Function): void {
    if (constructor === undefined || constructor === null) {
        throw new TypeError('The constructor to inherit from must be non-null');
    }

    if (superConstructor === undefined || superConstructor === null) {
        throw new TypeError('The super constructor to inherit from must be non-null');
    }

    if (typeof superConstructor !== 'function') {
        throw new TypeError('The super constructor must be a function');
    }

    Object.setPrototypeOf(constructor.prototype, superConstructor.prototype);
    Object.defineProperty(constructor, 'super_', {
        value: superConstructor,
        writable: false,
        configurable: false,
    });
}

// ============================================================================
// deprecate
// ============================================================================

export function deprecate<T extends Function>(fn: T, message: string, code?: string): T {
    let warned = false;

    const deprecated = function (this: any, ...args: any[]) {
        if (!warned) {
            warned = true;
            if (code) {
                console.warn(`[${code}] DeprecationWarning: ${message}`);
            } else {
                console.warn(`DeprecationWarning: ${message}`);
            }
        }
        return fn.apply(this, args);
    } as any;

    Object.defineProperty(deprecated, 'name', { value: fn.name });
    Object.defineProperty(deprecated, 'length', { value: fn.length });

    return deprecated;
}

// ============================================================================
// callbackify
// ============================================================================

export function callbackify<T>(fn: (...args: any[]) => Promise<T>): (...args: any[]) => void {
    return function (this: any, ...args: any[]) {
        const callback = args.pop();
        if (typeof callback !== 'function') {
            throw new TypeError('Callback must be a function');
        }

        fn.apply(this, args).then(
            (result) => callback(null, result),
            (err) => callback(err)
        );
    };
}

// ============================================================================
// promisify
// ============================================================================

export interface PromisifyInterface {
    __promisify__: Function;
}

export function promisify<T>(fn: Function): (...args: any[]) => Promise<T> {
    Object.defineProperty(fn, Symbol.for('nodejs.util.promisify.custom'), {
        value: (...args: any[]) => {
            return new Promise<T>((resolve, reject) => {
                fn(...args, (err: Error | null, result: T) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(result);
                    }
                });
            });
        },
    });

    // @ts-ignore - symbol index on function
    return fn[Symbol.for('nodejs.util.promisify.custom')];
}

promisify.custom = Symbol.for('nodejs.util.promisify.custom');

// ============================================================================
// types
// ============================================================================

export namespace types {
    export function isAnyArrayBuffer(value: unknown): value is ArrayBuffer {
        return value instanceof ArrayBuffer || value instanceof SharedArrayBuffer;
    }

    export function isArrayBuffer(value: unknown): value is ArrayBuffer {
        return value instanceof ArrayBuffer;
    }

    export function isArgumentsObject(value: unknown): value is IArguments {
        return value !== null && typeof value === 'object' && 'callee' in value;
    }

    export function isArrayBufferView(value: unknown): value is ArrayBufferView {
        return ArrayBuffer.isView(value);
    }

    export function isAsyncFunction(value: unknown): value is Function {
        return typeof value === 'function' && value.constructor.name === 'AsyncFunction';
    }

    export function isBigInt64Array(value: unknown): value is BigInt64Array {
        return value instanceof BigInt64Array;
    }

    export function isBigUint64Array(value: unknown): value is BigUint64Array {
        return value instanceof BigUint64Array;
    }

    export function isBooleanObject(value: unknown): value is Boolean {
        return value instanceof Boolean;
    }

    export function isBoxedPrimitive(value: unknown): value is Boolean | String | Number | Symbol | BigInt {
        return value instanceof Boolean || value instanceof String || value instanceof Number || typeof value === 'symbol' || typeof value === 'bigint';
    }

    export function isDataView(value: unknown): value is DataView {
        return value instanceof DataView;
    }

    export function isDate(value: unknown): value is Date {
        return value instanceof Date;
    }

    export function isFloat32Array(value: unknown): value is Float32Array {
        return value instanceof Float32Array;
    }

    export function isFloat64Array(value: unknown): value is Float64Array {
        return value instanceof Float64Array;
    }

    export function isGeneratorFunction(value: unknown): value is GeneratorFunction {
        return typeof value === 'function' && value.constructor.name === 'GeneratorFunction';
    }

    export function isGeneratorObject(value: unknown): value is Generator {
        return value !== null && typeof value === 'object' && typeof (value as any).next === 'function';
    }

    export function isInt8Array(value: unknown): value is Int8Array {
        return value instanceof Int8Array;
    }

    export function isInt16Array(value: unknown): value is Int16Array {
        return value instanceof Int16Array;
    }

    export function isInt32Array(value: unknown): value is Int32Array {
        return value instanceof Int32Array;
    }

    export function isMap(value: unknown): value is Map<unknown, unknown> {
        return value instanceof Map;
    }

    export function isMapIterator(value: unknown): boolean {
        return value !== null && typeof value === 'object' && typeof (value as any).next === 'function';
    }

    export function isModuleNamespaceObject(value: unknown): boolean {
        return value !== null && typeof value === 'object' && (value as any)[Symbol.toStringTag] === 'Module';
    }

    export function isNativeError(value: unknown): value is Error {
        return value instanceof Error;
    }

    export function isNumberObject(value: unknown): value is Number {
        return value instanceof Number;
    }

    export function isPromise(value: unknown): value is Promise<unknown> {
        return value instanceof Promise;
    }

    export function isProxy(value: unknown): boolean {
        return false; // 简化实现
    }

    export function isRegExp(value: unknown): value is RegExp {
        return value instanceof RegExp;
    }

    export function isSet(value: unknown): value is Set<unknown> {
        return value instanceof Set;
    }

    export function isSetIterator(value: unknown): boolean {
        return value !== null && typeof value === 'object' && typeof (value as any).next === 'function';
    }

    export function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
        return value instanceof SharedArrayBuffer;
    }

    export function isStringObject(value: unknown): value is String {
        return value instanceof String;
    }

    export function isSymbolObject(value: unknown): value is Object {
        return typeof value === 'object' && value !== null && typeof (value as any).valueOf() === 'symbol';
    }

    export function isTypedArray(value: unknown): value is NodeJS.TypedArray {
        return ArrayBuffer.isView(value) && !(value instanceof DataView);
    }

    export function isUint8Array(value: unknown): value is Uint8Array {
        return value instanceof Uint8Array;
    }

    export function isUint8ClampedArray(value: unknown): value is Uint8ClampedArray {
        return value instanceof Uint8ClampedArray;
    }

    export function isUint16Array(value: unknown): value is Uint16Array {
        return value instanceof Uint16Array;
    }

    export function isUint32Array(value: unknown): value is Uint32Array {
        return value instanceof Uint32Array;
    }

    export function isWeakMap(value: unknown): value is WeakMap<object, unknown> {
        return value instanceof WeakMap;
    }

    export function isWeakSet(value: unknown): value is WeakSet<object> {
        return value instanceof WeakSet;
    }

    export function isKeyObject(value: unknown): boolean {
        return false; // 简化实现
    }

    export function isCryptoKey(value: unknown): boolean {
        return false; // 简化实现
    }
}

// ============================================================================
// TextEncoder / TextDecoder
// ============================================================================

const { Encoder, Decoder } = import.meta.use('text')!;
export const TextEncoder = Encoder;
export const TextDecoder = Decoder;

// ============================================================================
// getSystemErrorMap / getSystemErrorName
// ============================================================================

export function getSystemErrorMap(): Map<number, [string, string]> {
    return new Map([
        [1, ['EPERM', 'operation not permitted']],
        [2, ['ENOENT', 'no such file or directory']],
        [3, ['ESRCH', 'no such process']],
        [4, ['EINTR', 'interrupted system call']],
        [5, ['EIO', 'i/o error']],
        [6, ['ENXIO', 'no such device or address']],
        [7, ['E2BIG', 'argument list too long']],
        [8, ['ENOEXEC', 'exec format error']],
        [9, ['EBADF', 'bad file descriptor']],
        [10, ['ECHILD', 'no child processes']],
        [11, ['EAGAIN', 'resource temporarily unavailable']],
        [12, ['ENOMEM', 'not enough memory']],
        [13, ['EACCES', 'permission denied']],
        [14, ['EFAULT', 'bad address']],
        [15, ['ENOTBLK', 'block device required']],
        [16, ['EBUSY', 'resource busy or locked']],
        [17, ['EEXIST', 'file already exists']],
        [18, ['EXDEV', 'cross-device link not permitted']],
        [19, ['ENODEV', 'no such device']],
        [20, ['ENOTDIR', 'not a directory']],
        [21, ['EISDIR', 'is a directory']],
        [22, ['EINVAL', 'invalid argument']],
        [23, ['ENFILE', 'file table overflow']],
        [24, ['EMFILE', 'too many open files']],
        [25, ['ENOTTY', 'not a tty']],
        [26, ['ETXTBSY', 'text file is busy']],
        [27, ['EFBIG', 'file too large']],
        [28, ['ENOSPC', 'no space left on device']],
        [29, ['ESPIPE', 'illegal seek']],
        [30, ['EROFS', 'read-only file system']],
        [31, ['EMLINK', 'too many links']],
        [32, ['EPIPE', 'broken pipe']],
        [33, ['EDOM', 'math argument out of domain of func']],
        [34, ['ERANGE', 'result too large']],
        [35, ['EDEADLK', 'resource deadlock avoided']],
        [36, ['ENAMETOOLONG', 'name too long']],
        [37, ['ENOLCK', 'no locks available']],
        [38, ['ENOSYS', 'function not implemented']],
        [39, ['ENOTEMPTY', 'directory not empty']],
        [40, ['ELOOP', 'too many symbolic links encountered']],
        [42, ['ENOMSG', 'no message of desired type']],
        [43, ['EIDRM', 'identifier removed']],
        [44, ['ECHRNG', 'channel number out of range']],
        [45, ['EL2NSYNC', 'level 2 not synchronized']],
        [46, ['EL3HLT', 'level 3 halted']],
        [47, ['EL3RST', 'level 3 reset']],
        [48, ['ELNRNG', 'link number out of range']],
        [49, ['EUNATCH', 'protocol driver not attached']],
        [50, ['ENOCSI', 'no csi structure available']],
        [51, ['EL2HLT', 'level 2 halted']],
        [52, ['EBADE', 'invalid exchange']],
        [53, ['EBADR', 'invalid request descriptor']],
        [54, ['EXFULL', 'exchange full']],
        [55, ['ENOANO', 'no anode']],
        [56, ['EBADRQC', 'invalid request code']],
        [57, ['EBADSLT', 'invalid slot']],
        [59, ['EBFONT', 'bad font file format']],
        [60, ['ENOSTR', 'device not a stream']],
        [61, ['ENODATA', 'no data available']],
        [62, ['ETIME', 'timer expired']],
        [63, ['ENOSR', 'out of streams resources']],
        [64, ['ENONET', 'machine is not on the network']],
        [65, ['ENOPKG', 'package not installed']],
        [66, ['EREMOTE', 'object is remote']],
        [67, ['ENOLINK', 'link has been severed']],
        [68, ['EADV', 'advertise error']],
        [69, ['ESRMNT', 'srmount error']],
        [70, ['ECOMM', 'communication error on send']],
        [71, ['EPROTO', 'protocol error']],
        [72, ['EMULTIHOP', 'multihop attempted']],
        [73, ['EDOTDOT', 'rfc name error']],
        [74, ['EBADMSG', 'bad message']],
        [75, ['EOVERFLOW', 'value too large for defined data type']],
        [76, ['ENOTUNIQ', 'name not unique on network']],
        [77, ['EBADFD', 'file descriptor in bad state']],
        [78, ['EREMCHG', 'remote address changed']],
        [79, ['ELIBACC', 'can not access a needed shared library']],
        [80, ['ELIBBAD', 'accessing a corrupted shared library']],
        [81, ['ELIBSCN', '.lib section in a.out corrupted']],
        [82, ['ELIBMAX', 'attempting to link in too many shared libraries']],
        [83, ['ELIBEXEC', 'cannot exec a shared library directly']],
        [84, ['EILSEQ', 'illegal byte sequence']],
        [85, ['ERESTART', 'interrupted system call should be restarted']],
        [86, ['ESTRPIPE', 'streams pipe error']],
        [87, ['EUSERS', 'too many users']],
        [88, ['ENOTSOCK', 'socket operation on non-socket']],
        [89, ['EDESTADDRREQ', 'destination address required']],
        [90, ['EMSGSIZE', 'message too long']],
        [91, ['EPROTOTYPE', 'protocol wrong type for socket']],
        [92, ['ENOPROTOOPT', 'protocol not available']],
        [93, ['EPROTONOSUPPORT', 'protocol not supported']],
        [94, ['ESOCKTNOSUPPORT', 'socket type not supported']],
        [95, ['EOPNOTSUPP', 'operation not supported on transport endpoint']],
        [96, ['EPFNOSUPPORT', 'protocol family not supported']],
        [97, ['EAFNOSUPPORT', 'address family not supported by protocol']],
        [98, ['EADDRINUSE', 'address already in use']],
        [99, ['EADDRNOTAVAIL', 'address not available']],
        [100, ['ENETDOWN', 'network is down']],
        [101, ['ENETUNREACH', 'network unreachable']],
        [102, ['ENETRESET', 'network dropped connection on reset']],
        [103, ['ECONNABORTED', 'software caused connection abort']],
        [104, ['ECONNRESET', 'connection reset by peer']],
        [105, ['ENOBUFS', 'no buffer space available']],
        [106, ['EISCONN', 'transport endpoint is already connected']],
        [107, ['ENOTCONN', 'transport endpoint is not connected']],
        [108, ['ESHUTDOWN', 'cannot send after transport endpoint shutdown']],
        [109, ['ETIMEDOUT', 'connection timed out']],
        [110, ['ECONNREFUSED', 'connection refused']],
        [111, ['EHOSTDOWN', 'host is down']],
        [112, ['EHOSTUNREACH', 'host unreachable']],
        [113, ['EALREADY', 'operation already in progress']],
        [114, ['EINPROGRESS', 'operation now in progress']],
        [115, ['ESTALE', 'stale file handle']],
        [116, ['EUCLEAN', 'structure needs cleaning']],
        [117, ['ENOTNAM', 'not a xenix named type file']],
        [118, ['ENAVAIL', 'no xenix semaphores available']],
        [119, ['EISNAM', 'is a named type file']],
        [120, ['EREMOTEIO', 'remote i/o error']],
        [121, ['EDQUOT', 'disk quota exceeded']],
        [122, ['ENOMEDIUM', 'no medium found']],
        [123, ['EMEDIUMTYPE', 'wrong medium type']],
        [124, ['ECANCELED', 'operation canceled']],
        [125, ['ENOKEY', 'required key not available']],
        [126, ['EKEYEXPIRED', 'key has expired']],
        [127, ['EKEYREVOKED', 'key has been revoked']],
        [128, ['EKEYREJECTED', 'key was rejected by service']],
        [129, ['EOWNERDEAD', 'owner died']],
        [130, ['ENOTRECOVERABLE', 'state not recoverable']],
        [131, ['ERFKILL', 'operation not possible due to rf-kill']],
        [132, ['EHWPOISON', 'memory page has hardware error']],
    ]);
}

export function getSystemErrorName(err: number): string {
    const entry = getSystemErrorMap().get(err);
    return entry ? entry[0] : `Unknown system error ${err}`;
}