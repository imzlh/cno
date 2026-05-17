/**
 * Node.js os 模块
 * 提供操作系统相关的实用方法和属性
 * 类型定义参考 @types/node/os.d.ts
 */

const os = import.meta.use('os');
const sig = import.meta.use('signals');
const err = import.meta.use('error');

const uname = os.uname();
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

// ============================================================================
// 常量
// ============================================================================

export const constants = {
    UV_UDP_REUSEADDR: 0,

    signals: Object.fromEntries(
        Object.entries(sig.signals).map(([k, v]) => [k, v])
    ) as { [key in NodeJS.Signals]: number },

    errno: Object.fromEntries(
        Object.entries(err.errno).filter(([k]) => k !== 'OK' && k !== 'UNKNOWN')
    ) as any,

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

// ============================================================================
// 常量属性
// ============================================================================

/** 空设备的路径 */
export const devNull = uname.sysname === 'Windows_NT' ? '\\\\.\\NUL' : '/dev/null';

/** 操作系统特定的行尾标记 */
export const EOL = uname.sysname === 'Windows_NT' ? '\r\n' : '\n';

// ============================================================================
// 函数实现
// ============================================================================

/**
 * 返回操作系统的主机名
 */
export function hostname(): string {
    return os.hostName;
}

/**
 * 返回包含 1、5 和 15 分钟平均负载的数组
 */
export function loadavg(): number[] {
    return os.loadavg();
}

/**
 * 返回系统正常运行时间（秒）
 */
export function uptime(): number {
    return os.uptime();
}

/**
 * 返回可用系统内存量（字节）
 */
export function freemem(): number {
    return os.memoryUsage()['os.free'];
}

/**
 * 返回系统总内存量（字节）
 */
export function totalmem(): number {
    return os.memoryUsage()['os.total'];
}

/**
 * 返回 CPU 信息数组
 */
export function cpus(): CpuInfo[] {
    return os.cpuInfo();
}

/**
 * 返回程序应使用的默认并行度估计值
 */
export function availableParallelism(): number {
    return os.availableParallelism();
}

/**
 * 返回操作系统名称
 */
export function type(): string {
    return uname.sysname;
}

/**
 * 返回操作系统发行版本
 */
export function release(): string {
    return uname.release;
}

/**
 * 返回网络接口信息
 */
export function networkInterfaces(): NodeJS.Dict<NetworkInterfaceInfo[]> {
    const interfaces = os.networkInterfaces();
    const result: NodeJS.Dict<NetworkInterfaceInfo[]> = {};

    for (const iface of interfaces) {
        if (!result[iface.name]) {
            result[iface.name] = [];
        }

        const isIPv6 = iface.address.includes(':');
        const cidr = `${iface.address}/${isIPv6 ? 128 : 32}`;

        if (isIPv6) {
            result[iface.name]!.push({
                family: 'IPv6',
                address: iface.address,
                netmask: iface.netmask,
                mac: iface.mac,
                internal: iface.internal,
                cidr,
                scopeid: iface.scopeId ?? 0,
            });
        } else {
            result[iface.name]!.push({
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
 * 返回当前用户的主目录路径
 */
export function homedir(): string {
    return os.homeDir;
}

export interface UserInfoOptions {
    encoding?: BufferEncoding | 'buffer' | undefined;
}

/**
 * 返回当前有效用户的信息
 */
export function userInfo(options?: UserInfoOptions): UserInfo<string> {
    const info = os.userInfo;
    return {
        username: info.userName,
        uid: info.userId,
        gid: info.groupId,
        shell: info.shell,
        homedir: info.homeDir ?? os.homeDir,
    };
}

/**
 * 返回 Node.js 二进制文件编译时的操作系统 CPU 架构
 */
export function arch(): NodeJS.Architecture {
    const machine = uname.machine;
    // 映射到 Node.js 架构名称
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
 * 返回内核版本字符串
 */
export function version(): string {
        return uname.version;
}

/**
 * 返回操作系统平台字符串
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
        case 'Freebsd':
            return 'freebsd';
        case 'Openbsd':
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
 * 返回机器类型字符串
 */
export function machine(): string {
    return uname.machine;
}

/**
 * 返回临时文件的默认目录
 */
export function tmpdir(): string {
    return os.tmpDir;
}

/**
 * 返回 CPU 的字节序
 */
export function endianness(): 'BE' | 'LE' {
    const buffer = new ArrayBuffer(2);
    new Uint16Array(buffer)[0] = 1;
    return new Uint8Array(buffer)[0] === 1 ? 'LE' : 'BE';
}

export function getPriority(pid?: number): number {
    try {
        return (os as any).getPriority?.(pid ?? 0) ?? 0;
    } catch {
        throw new RangeError(`getPriority ${pid} is not a valid pid`);
    }
}

export function setPriority(priority: number): void;
export function setPriority(pid: number, priority: number): void;
export function setPriority(pidOrPriority: number, priority?: number): void {
    const pid = priority !== undefined ? pidOrPriority : 0;
    const prio = priority ?? pidOrPriority;
    try {
        (os as any).setPriority?.(pid, prio);
    } catch {
        throw new RangeError(`setPriority ${prio} is out of range`);
    }
}