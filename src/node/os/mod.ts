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

const priorityOS: PriorityNativeOS = os;
// Node exposes positive platform errno in os.constants.errno; UV stores negatives.
const errnoConstants: Record<string, number> = Object.fromEntries(
    Object.entries(err.errno)
        .filter(([k, v]) => k !== 'OK' && k !== 'UNKNOWN' && typeof v === 'number')
        .map(([k, v]) => [k, Math.abs(v as number)])
);
export interface CpuInfo {
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

export interface NetworkInterfaceBase {
    address: string;
    netmask: string;
    mac: string;
    internal: boolean;
    cidr: string | null;
    scopeid?: number;
}

export interface NetworkInterfaceInfoIPv4 extends NetworkInterfaceBase {
    family: 'IPv4';
}

export interface NetworkInterfaceInfoIPv6 extends NetworkInterfaceBase {
    family: 'IPv6';
    scopeid: number;
}

export interface UserInfo<T> {
    username: T;
    uid: number;
    gid: number;
    shell: T | null;
    homedir: T;
}

export type NetworkInterfaceInfo = NetworkInterfaceInfoIPv4 | NetworkInterfaceInfoIPv6;

// Constants

export const constants = {
    UV_UDP_REUSEADDR: 0,

    // `signals` is null inside a worker thread (POSIX signals are process-wide,
    // not per-thread) — fall back to an empty map instead of crashing on import.
    signals: Object.fromEntries(
        Object.entries(sig?.signals ?? {}).map(([k, v]) => [k, v])
    ) as SignalConstants,

    errno: errnoConstants,

    dlopen: {
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
export const devNull = uname.sysname === 'Windows_NT' ? '\\\\.\\NUL' : '/dev/null';

/** Operating system-specific end-of-line marker */
export const EOL = uname.sysname === 'Windows_NT' ? '\r\n' : '\n';

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
        const cidr = iface.cidr ?? `${iface.address}/${isIPv6 ? 128 : 32}`;

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

export interface UserInfoOptions {
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

function validateInt32(value: number, name: string): void {
    if (!Number.isInteger(value)) {
        throw new RangeError(`The value of "${name}" is out of range. It must be an integer.`);
    }
    if (value < -2147483648 || value > 2147483647) {
        throw new RangeError(`The value of "${name}" is out of range. It must be >= -2147483648 && <= 2147483647.`);
    }
}

function validatePriority(priority: number): void {
    if (!Number.isInteger(priority)) {
        throw new RangeError('The value of "priority" is out of range. It must be an integer.');
    }
    if (priority < -20 || priority > 19) {
        throw new RangeError('The value of "priority" is out of range. It must be >= -20 && <= 19.');
    }
}

export function getPriority(pid?: number): number {
    validateInt32(pid ?? 0, 'pid');
    try {
        return priorityOS.getPriority?.(pid ?? 0) ?? 0;
    } catch {
        throw new RangeError(`getPriority ${pid} is not a valid pid`);
    }
}

export function setPriority(priority: number): void;
export function setPriority(pid: number, priority: number): void;
export function setPriority(pidOrPriority: number, priority?: number): void {
    const pid = priority !== undefined ? pidOrPriority : 0;
    const prio = priority ?? pidOrPriority;
    validateInt32(pid, 'pid');
    validatePriority(prio);
    try {
        priorityOS.setPriority?.(pid, prio);
    } catch {
        throw new RangeError(`setPriority ${prio} is out of range`);
    }
}

function installPrimitiveCoercion(fn: () => string, getValue: () => string): void {
    Object.defineProperties(fn, {
        toString: { value: getValue, configurable: true },
        [Symbol.toPrimitive]: { value: getValue, configurable: true },
    });
}

installPrimitiveCoercion(arch, arch);
installPrimitiveCoercion(endianness, endianness);
installPrimitiveCoercion(platform, platform);
