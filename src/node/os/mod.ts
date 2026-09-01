/**
 * Node.js os module
 * Operating system-related utility methods and properties
 * Type definitions reference: @types/node/os.d.ts
 */

import { Buffer } from '../buffer';

const os = import.meta.use('os');
const sig = import.meta.use('signals');
const err = import.meta.use('error');

const uname = os.uname();

interface PriorityNativeOS {
    getPriority?: (pid: number) => number;
    setPriority?: (pid: number, priority: number) => void;
}

type NetworkInterfaceWithCidr = CModuleOS.NetworkInterface & {
    cidr?: string | null;
};

type SignalConstants = { [key in NodeJS.Signals]: number };

const priorityOS = os as typeof os & PriorityNativeOS;
const isWindows = uname.sysname === 'Windows_NT';

// Node's os.constants.errno holds *platform* errno, not libuv's. On Unix libuv
// codes are -(platform errno) so Math.abs recovers them; on Windows libuv uses
// its own -4095.. range, so the platform table has to be spelled out.
const WIN32_ERRNO: Record<string, number> = {
    E2BIG: 7, EACCES: 13, EADDRINUSE: 100, EADDRNOTAVAIL: 101, EAFNOSUPPORT: 102, EAGAIN: 11,
    EALREADY: 103, EBADF: 9, EBADMSG: 104, EBUSY: 16, ECANCELED: 105, ECHILD: 10,
    ECONNABORTED: 106, ECONNREFUSED: 107, ECONNRESET: 108, EDEADLK: 36, EDESTADDRREQ: 109,
    EDOM: 33, EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 110, EIDRM: 111, EILSEQ: 42,
    EINPROGRESS: 112, EINTR: 4, EINVAL: 22, EIO: 5, EISCONN: 113, EISDIR: 21, ELOOP: 114,
    EMFILE: 24, EMLINK: 31, EMSGSIZE: 115, ENAMETOOLONG: 38, ENETDOWN: 116, ENETRESET: 117,
    ENETUNREACH: 118, ENFILE: 23, ENOBUFS: 119, ENODATA: 120, ENODEV: 19, ENOENT: 2,
    ENOEXEC: 8, ENOLCK: 39, ENOLINK: 121, ENOMEM: 12, ENOMSG: 122, ENOPROTOOPT: 123,
    ENOSPC: 28, ENOSR: 124, ENOSTR: 125, ENOSYS: 40, ENOTCONN: 126, ENOTDIR: 20, ENOTEMPTY: 41,
    ENOTSOCK: 128, ENOTSUP: 129, ENOTTY: 25, ENXIO: 6, EOPNOTSUPP: 130, EOVERFLOW: 132,
    EPERM: 1, EPIPE: 32, EPROTO: 134, EPROTONOSUPPORT: 135, EPROTOTYPE: 136, ERANGE: 34,
    EROFS: 30, ESPIPE: 29, ESRCH: 3, ETIME: 137, ETIMEDOUT: 138, ETXTBSY: 139,
    EWOULDBLOCK: 140, EXDEV: 18, WSAEINTR: 10004, WSAEBADF: 10009, WSAEACCES: 10013,
    WSAEFAULT: 10014, WSAEINVAL: 10022, WSAEMFILE: 10024, WSAEWOULDBLOCK: 10035,
    WSAEINPROGRESS: 10036, WSAEALREADY: 10037, WSAENOTSOCK: 10038, WSAEDESTADDRREQ: 10039,
    WSAEMSGSIZE: 10040, WSAEPROTOTYPE: 10041, WSAENOPROTOOPT: 10042, WSAEPROTONOSUPPORT: 10043,
    WSAESOCKTNOSUPPORT: 10044, WSAEOPNOTSUPP: 10045, WSAEPFNOSUPPORT: 10046,
    WSAEAFNOSUPPORT: 10047, WSAEADDRINUSE: 10048, WSAEADDRNOTAVAIL: 10049, WSAENETDOWN: 10050,
    WSAENETUNREACH: 10051, WSAENETRESET: 10052, WSAECONNABORTED: 10053, WSAECONNRESET: 10054,
    WSAENOBUFS: 10055, WSAEISCONN: 10056, WSAENOTCONN: 10057, WSAESHUTDOWN: 10058,
    WSAETOOMANYREFS: 10059, WSAETIMEDOUT: 10060, WSAECONNREFUSED: 10061, WSAELOOP: 10062,
    WSAENAMETOOLONG: 10063, WSAEHOSTDOWN: 10064, WSAEHOSTUNREACH: 10065, WSAENOTEMPTY: 10066,
    WSAEPROCLIM: 10067, WSAEUSERS: 10068, WSAEDQUOT: 10069, WSAESTALE: 10070,
    WSAEREMOTE: 10071, WSASYSNOTREADY: 10091, WSAVERNOTSUPPORTED: 10092,
    WSANOTINITIALISED: 10093, WSAEDISCON: 10101, WSAENOMORE: 10102, WSAECANCELLED: 10103,
    WSAEINVALIDPROCTABLE: 10104, WSAEINVALIDPROVIDER: 10105, WSAEPROVIDERFAILEDINIT: 10106,
    WSASYSCALLFAILURE: 10107, WSASERVICE_NOT_FOUND: 10108, WSATYPE_NOT_FOUND: 10109,
    WSA_E_NO_MORE: 10110, WSA_E_CANCELLED: 10111, WSAEREFUSED: 10112,
};

// libuv-only names with no platform errno; Node keeps them out of os.constants.errno.
const UV_ONLY_ERRNO = /^(EOF|UNKNOWN|OK|ECHARSET|EAI_|ENONET|EFTYPE|EHOSTDOWN|EREMOTEIO|ESOCKTNOSUPPORT|EUNATCH|ESHUTDOWN)/;

const errnoConstants: Record<string, number> = isWindows
    ? { ...WIN32_ERRNO }
    : Object.fromEntries(
        Object.entries(err.errno)
            .filter(([k, v]) => typeof v === 'number' && !UV_ONLY_ERRNO.test(k))
            .map(([k, v]) => [k, Math.abs(v as number)])
    );
interface CpuInfo {
    model: string;
    speed: number;
    times: {
        user: number;
        nice: number;
        sys: number;
        idle: number;
        irq: number;
    };
}

interface NetworkInterfaceBase {
    address: string;
    netmask: string;
    mac: string;
    internal: boolean;
    cidr: string | null;
    scopeid?: number;
}

interface NetworkInterfaceInfoIPv4 extends NetworkInterfaceBase {
    family: 'IPv4';
}

interface NetworkInterfaceInfoIPv6 extends NetworkInterfaceBase {
    family: 'IPv6';
    scopeid: number;
}

interface UserInfo<T> {
    username: T;
    uid: number;
    gid: number;
    shell: T | null;
    homedir: T;
}

type NetworkInterfaceInfo = NetworkInterfaceInfoIPv4 | NetworkInterfaceInfoIPv6;

// Constants

export const constants = {
    UV_UDP_REUSEADDR: 4,

    // `signals` is null inside a worker thread (POSIX signals are process-wide,
    // not per-thread) — fall back to an empty map instead of crashing on import.
    signals: Object.fromEntries(
        Object.entries(sig?.signals ?? {}).map(([k, v]) => [k, v])
    ) as SignalConstants,

    errno: errnoConstants,

    // RTLD_* are POSIX only; Node ships an empty dlopen map on Windows.
    dlopen: isWindows ? {} : {
        RTLD_LAZY: 1,
        RTLD_NOW: 2,
        RTLD_GLOBAL: 256,
        RTLD_LOCAL: 0,
        RTLD_DEEPBIND: 8,
    },

    priority: {
        PRIORITY_LOW: 19,
        PRIORITY_BELOW_NORMAL: 10,
        PRIORITY_NORMAL: 0,
        PRIORITY_ABOVE_NORMAL: -7,
        PRIORITY_HIGH: -14,
        PRIORITY_HIGHEST: -20,
    },
};

// Constant properties

/** Path of the null device */
export const devNull = isWindows ? '\\\\.\\nul' : '/dev/null';

/** Operating system-specific end-of-line marker */
export const EOL = isWindows ? '\r\n' : '\n';

// Function implementations

/**
 * Returns the operating system hostname
 */
export function hostname(): string {
    return os.hostName;
}

/**
 * Returns an array containing the 1, 5, and 15 minute load averages
 */
export function loadavg(): number[] {
    return os.loadavg();
}

/**
 * Returns the system uptime in seconds
 */
export function uptime(): number {
    return os.uptime();
}

/**
 * Returns the amount of free system memory in bytes
 */
export function freemem(): number {
    return os.memoryUsage()['os.free'];
}

/**
 * Returns the total amount of system memory in bytes
 */
export function totalmem(): number {
    return os.memoryUsage()['os.total'];
}

/**
 * Returns an array of CPU information
 */
export function cpus(): CpuInfo[] {
    return os.cpuInfo().map(cpu => ({
        ...cpu,
        times: cpu.times ?? { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    }));
}

/**
 * Returns an estimate of the default parallelism a program should use
 */
export function availableParallelism(): number {
    return os.availableParallelism();
}

/**
 * Returns the operating system name
 */
export function type(): string {
    return uname.sysname;
}

/**
 * Returns the operating system release
 */
export function release(): string {
    return uname.release;
}

/** Bit count of a contiguous IPv4 dotted-quad or IPv6 hex netmask, or null. */
function netmaskPrefix(netmask: string, isIPv6: boolean): number | null {
    const groups: number[] = [];
    if (isIPv6) {
        const parts = netmask.split('::');
        if (parts.length > 2) return null;
        const head = parts[0] ? parts[0].split(':') : [];
        const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
        if (head.length + tail.length > 8) return null;
        const fill = new Array(8 - head.length - tail.length).fill('0');
        for (const g of [...head, ...(parts.length === 2 ? fill : []), ...tail]) {
            const n = parseInt(g, 16);
            if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
            groups.push(n >> 8, n & 0xff);
        }
        if (groups.length !== 16) return null;
    } else {
        const parts = netmask.split('.');
        if (parts.length !== 4) return null;
        for (const p of parts) {
            const n = Number(p);
            if (!Number.isInteger(n) || n < 0 || n > 255) return null;
            groups.push(n);
        }
    }

    let bits = 0;
    let seenZero = false;
    for (const byte of groups) {
        for (let i = 7; i >= 0; i--) {
            if ((byte >> i) & 1) {
                if (seenZero) return null;  // non-contiguous mask
                bits++;
            } else seenZero = true;
        }
    }
    return bits;
}

/** Node derives `cidr` from address + netmask; a bad mask yields null. */
function toCidr(address: string, netmask: string, isIPv6: boolean): string | null {
    const prefix = netmaskPrefix(netmask, isIPv6);
    return prefix === null ? null : `${address}/${prefix}`;
}

/**
 * Returns network interface information
 */
export function networkInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]> {
    let interfaces: NetworkInterfaceWithCidr[];
    try {
        interfaces = os.networkInterfaces();
    } catch {
        return {
            lo: [{
                family: 'IPv4',
                address: '127.0.0.1',
                netmask: '255.0.0.0',
                mac: '00:00:00:00:00:00',
                internal: true,
                cidr: '127.0.0.1/8',
            }],
        };
    }
    const result: NodeJS.Dict<NetworkInterfaceInfo[]> = {};

    for (const iface of interfaces) {
        const entries = result[iface.name] ??= [];

        const isIPv6 = iface.address.includes(':');
        const cidr = iface.cidr ?? toCidr(iface.address, iface.netmask, isIPv6);

        if (isIPv6) {
            entries.push({
                family: 'IPv6',
                address: iface.address,
                netmask: iface.netmask,
                mac: iface.mac,
                internal: iface.internal,
                cidr,
                scopeid: iface.scopeId ?? 0,
            });
        } else {
            entries.push({
                family: 'IPv4',
                address: iface.address,
                netmask: iface.netmask,
                mac: iface.mac,
                internal: iface.internal,
                cidr,
            });
        }
    }

    return result;
}

/**
 * Returns the home directory of the current user
 */
export function homedir(): string {
    return os.homeDir;
}

interface UserInfoOptions {
    encoding?: BufferEncoding | 'buffer' | undefined;
}

/**
 * Returns information about the current effective user
 */
function encodeUserInfoValue(value: string, options?: UserInfoOptions): string | Buffer {
    return options?.encoding === 'buffer' ? Buffer.from(value) : value;
}

export function userInfo(options?: UserInfoOptions): UserInfo<string>;
export function userInfo(options: { encoding: 'buffer' }): UserInfo<Buffer>;
export function userInfo(options?: UserInfoOptions): UserInfo<string | Buffer> {
    const info = os.userInfo;
    const shell = info.shell;
    const home = info.homeDir ?? os.homeDir;
    return {
        username: encodeUserInfoValue(info.userName, options),
        uid: info.userId,
        gid: info.groupId,
        shell: shell === null ? null : encodeUserInfoValue(shell, options),
        homedir: encodeUserInfoValue(home, options),
    };
}

/**
 * Returns the operating system CPU architecture for which the Node.js binary was compiled
 */
export function arch(): NodeJS.Architecture {
    const machine = uname.machine;
    // Map to Node.js architecture names
    switch (machine) {
        case 'x86_64':
        case 'amd64':
            return 'x64';
        case 'i386':
        case 'i686':
            return 'ia32';
        case 'arm':
            return 'arm';
        case 'aarch64':
        case 'arm64':
            return 'arm64';
        case 'mips':
            return 'mips';
        case 'mipsel':
            return 'mipsel';
        case 'ppc64':
            return 'ppc64';
        case 'ppc64le':
            return 'ppc64';
        case 's390x':
            return 's390x';
        case 'riscv64':
            return 'riscv64';
        case 'loong64':
            return 'loong64';
        default:
            return machine as NodeJS.Architecture;
    }
}

/**
 * Returns the kernel version string
 */
export function version(): string {
    return uname.version;
}

/**
 * Returns the operating system platform string
 */
export function platform(): NodeJS.Platform {
    const platform = uname.sysname;
    switch (platform) {
        case 'Linux':
            return 'linux';
        case 'Darwin':
            return 'darwin';
        case 'Windows_NT':
            return 'win32';
        case 'FreeBSD':
            return 'freebsd';
        case 'OpenBSD':
            return 'openbsd';
        case 'Sunos':
            return 'sunos';
        case 'Aix':
            return 'aix';
        case 'Android':
            return 'android';
        default:
            return platform as NodeJS.Platform;
    }
}

/**
 * Returns the machine type string
 */
export function machine(): string {
    return uname.machine;
}

/**
 * Returns the default directory for temporary files
 */
export function tmpdir(): string {
    return os.tmpDir;
}

/**
 * Returns the byte order of the CPU
 */
export function endianness(): 'BE' | 'LE' {
    const buffer = new ArrayBuffer(2);
    new Uint16Array(buffer)[0] = 1;
    return new Uint8Array(buffer)[0] === 1 ? 'LE' : 'BE';
}

function outOfRange(name: string, reason: string, actual: number): RangeError {
    const text = String(actual);
    let received = text;
    if (Object.is(actual, -0)) {
        received = '-0';
    } else if (Number.isInteger(actual) && Math.abs(actual) > 2 ** 32) {
        received = '';
        let i = text.length;
        const start = text[0] === '-' ? 1 : 0;
        for (; i >= start + 4; i -= 3) received = `_${text.slice(i - 3, i)}${received}`;
        received = `${text.slice(0, i)}${received}`;
    }
    const e = new RangeError(
        `The value of "${name}" is out of range. It must be ${reason}. `
        + `Received ${received}`,
    ) as RangeError & { code?: string };
    e.code = 'ERR_OUT_OF_RANGE';
    return e;
}

function invalidArgType(name: string, actual: unknown): TypeError {
    let received: string;
    if (actual === null) {
        received = 'null';
    } else if (actual === undefined) {
        received = 'undefined';
    } else {
        const t = typeof actual;
        if (t === 'string') received = `type string ('${actual as string}')`;
        else if (t === 'number') received = `type number (${Object.is(actual, -0) ? '-0' : String(actual)})`;
        else if (t === 'bigint') received = `type bigint (${String(actual)}n)`;
        else if (t === 'boolean') received = `type boolean (${String(actual)})`;
        else if (t === 'symbol') received = `type symbol (${String(actual)})`;
        else if (t === 'function') received = `function ${(actual as { name?: string }).name ?? ''}`;
        else if (t === 'object') {
            if (Object.getPrototypeOf(actual) === null) received = '[Object: null prototype] {}';
            else {
                const ctor = (actual as object).constructor;
                received = `an instance of ${ctor && ctor.name ? ctor.name : 'Object'}`;
            }
        } else received = `type ${t}`;
    }
    const e = new TypeError(
        `The "${name}" argument must be of type number. Received ${received}`,
    ) as TypeError & { code?: string };
    e.code = 'ERR_INVALID_ARG_TYPE';
    return e;
}

/**
 * Node's validateInt32: a non-number is a TypeError (ERR_INVALID_ARG_TYPE), a
 * non-integer number is ERR_OUT_OF_RANGE "must be an integer", and only then is
 * the range checked. Getting the ORDER wrong changes which error callers see.
 */
function validateInt32(value: unknown, name: string, min = -2147483648, max = 2147483647): number {
    if (typeof value !== 'number') throw invalidArgType(name, value);
    if (!Number.isInteger(value)) throw outOfRange(name, 'an integer', value);
    if (value < min || value > max) throw outOfRange(name, `>= ${min} && <= ${max}`, value);
    return value;
}

function systemError(syscall: string): Error {
    const e = new Error(
        `A system error occurred: ${syscall} returned ESRCH (no such process)`,
    ) as Error & { code?: string; errno?: number; syscall?: string; info?: unknown };
    e.code = 'ERR_SYSTEM_ERROR';
    e.syscall = syscall;
    e.errno = -4040;
    e.info = { errno: -4040, code: 'ESRCH', message: 'no such process', syscall };
    return e;
}

/**
 * The native binding exposes no uv_os_{get,set}priority, so a bogus pid would
 * otherwise be silently accepted. `process.kill(pid, 0)` delivers no signal and
 * reports ESRCH for a dead pid, which recovers Node's error for that case.
 * Deliberately ESRCH-only: an EPERM/EACCES pid DOES exist, and Node's
 * uv_os_getpriority can still read it, so those must not be turned into errors.
 */
function assertPidExists(pid: number, syscall: string): void {
    if (pid === 0) return;
    const proc = globalThis.process as unknown as { pid?: number; kill?: (p: number, s: number | string) => unknown } | undefined;
    if (!proc || typeof proc.kill !== 'function') return;
    if (pid === proc.pid) return;
    try {
        proc.kill(pid, 0);
    } catch (e) {
        if ((e as { code?: string } | null)?.code === 'ESRCH') throw systemError(syscall);
    }
}

export function getPriority(pid?: number): number {
    // Node uses a default parameter (`pid = 0`), so ONLY undefined defaults —
    // `pid ?? 0` would wrongly accept null and return a bogus priority.
    const target = validateInt32(pid === undefined ? 0 : pid, 'pid');
    assertPidExists(target, 'uv_os_getpriority');
    // NOTE: no native uv_os_getpriority binding exists, so this reports the
    // default priority rather than the process's real one. See audit notes.
    return priorityOS.getPriority?.(target) ?? 0;
}

export function setPriority(priority: number): void;
export function setPriority(pid: number, priority: number): void;
export function setPriority(pidOrPriority: number, priority?: number): void {
    // Node's exact swap: it tests `priority === undefined`, so setPriority(0, null)
    // must NOT be treated as the one-argument form (a `??` here would swallow null).
    let pid: unknown = pidOrPriority;
    let prio: unknown = priority;
    if (prio === undefined) { prio = pid; pid = 0; }
    const validPid = validateInt32(pid, 'pid');
    const validPrio = validateInt32(prio, 'priority', -20, 19);
    assertPidExists(validPid, 'uv_os_setpriority');
    // NOTE: no native uv_os_setpriority binding exists, so this cannot actually
    // change scheduling priority. See audit notes.
    priorityOS.setPriority?.(validPid, validPrio);
}

function installPrimitiveCoercion(fn: (...args: never[]) => unknown, getValue: () => unknown): void {
    Object.defineProperties(fn, {
        toString: { value: () => String(getValue()), configurable: true },
        [Symbol.toPrimitive]: { value: getValue, configurable: true },
    });
}

// Node installs Symbol.toPrimitive on every zero-arg os getter, so `${os.arch}`
// and `os.homedir + ''` work without the call.
installPrimitiveCoercion(arch, arch);
installPrimitiveCoercion(availableParallelism, availableParallelism);
installPrimitiveCoercion(endianness, endianness);
installPrimitiveCoercion(freemem, freemem);
installPrimitiveCoercion(homedir, homedir);
installPrimitiveCoercion(hostname, hostname);
installPrimitiveCoercion(machine, machine);
installPrimitiveCoercion(platform, platform);
installPrimitiveCoercion(release, release);
installPrimitiveCoercion(tmpdir, tmpdir);
installPrimitiveCoercion(totalmem, totalmem);
installPrimitiveCoercion(type, type);
installPrimitiveCoercion(uptime, uptime);
installPrimitiveCoercion(version, version);

// `export type` (not `export interface`) so `export * from './mod'`
// cannot materialise these as undefined runtime exports.
export type {
    CpuInfo,
    NetworkInterfaceBase,
    NetworkInterfaceInfoIPv4,
    NetworkInterfaceInfoIPv6,
    UserInfo,
    NetworkInterfaceInfo,
    UserInfoOptions,
};
