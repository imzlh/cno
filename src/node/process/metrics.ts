/**
 * Process metrics functions: hrtime, memoryUsage, cpuUsage, resourceUsage.
 */

const os = import.meta.use('os');

// hrtime (high-resolution time based on performance.now)

const hrtimeOrigin = typeof performance !== 'undefined' ? performance.now() : Date.now();

export function hrtime(time?: [number, number]): [number, number] {
    const nowMicro = typeof performance !== 'undefined'
        ? performance.now() - hrtimeOrigin
        : Date.now() - hrtimeOrigin;
    const totalNs = Math.round(nowMicro * 1e6);
    const seconds = Math.floor(totalNs / 1e9);
    const nanoseconds = totalNs % 1e9;

    if (time) {
        let diffSeconds = seconds - time[0];
        let diffNanoseconds = nanoseconds - time[1];
        if (diffNanoseconds < 0) {
            diffSeconds -= 1;
            diffNanoseconds += 1e9;
        }
        return [diffSeconds, diffNanoseconds];
    }

    return [seconds, nanoseconds];
}

hrtime.bigint = function (): bigint {
    const [seconds, nanoseconds] = hrtime();
    return BigInt(seconds) * BigInt(1e9) + BigInt(nanoseconds);
};

// memoryUsage

export function memoryUsage(): NodeJS.MemoryUsage {
    const memory = os.memoryUsage();
    return {
        rss: memory['os.rss'],
        heapTotal: memory['used'],
        heapUsed: memory['used'],
        external: memory['vm.used'],
        arrayBuffers: memory['buffer.used'],
    };
}

memoryUsage.rss = function (): number {
    return os.memoryUsage()['os.rss'];
};

// cpuUsage

export function cpuUsage(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage {
    const cpus = os.cpuInfo();
    if (cpus.length === 0) return { user: 0, system: 0 };

    // Aggregate across all cores
    let totalUser = 0, totalNice = 0, totalSys = 0;
    for (const cpu of cpus) {
        totalUser += cpu.times.user;
        totalNice += cpu.times.nice;
        totalSys += cpu.times.sys;
    }

    const current = {
        user: (totalUser + totalNice) * 1000,
        system: totalSys * 1000,
    };

    if (previousValue) {
        validateCpuUsage(previousValue);
        return {
            user: Math.max(0, current.user - previousValue.user),
            system: Math.max(0, current.system - previousValue.system),
        };
    }

    return current;
}

function validateCpuUsage(value: NodeJS.CpuUsage): void {
    if (value === null || typeof value !== 'object') {
        throw new TypeError('The "previousValue" argument must be an object');
    }
    validateCpuUsageNumber(value.user, 'user');
    validateCpuUsageNumber(value.system, 'system');
}

function validateCpuUsageNumber(value: unknown, key: 'user' | 'system'): void {
    if (typeof value !== 'number') {
        throw new TypeError(`The "previousValue.${key}" property must be a number`);
    }
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`The "previousValue.${key}" property must be a non-negative finite number`);
    }
}

// resourceUsage

export function resourceUsage(): NodeJS.ResourceUsage {
    const mem = os.memoryUsage();
    const cpus = os.cpuInfo();
    let totalUser = 0, totalSys = 0;
    for (const cpu of cpus) {
        totalUser += cpu.times.user + cpu.times.nice;
        totalSys += cpu.times.sys;
    }
    return {
        fsRead: 0,
        fsWrite: 0,
        involuntaryContextSwitches: 0,
        ipcReceived: 0,
        ipcSent: 0,
        majorPageFault: 0,
        maxRSS: mem['os.rss'],
        minorPageFault: 0,
        sharedMemorySize: 0,
        signalsCount: 0,
        swappedOut: 0,
        systemCPUTime: totalSys * 1e6,
        unsharedDataSize: 0,
        unsharedStackSize: 0,
        userCPUTime: totalUser * 1e6,
        voluntaryContextSwitches: 0,
    };
}
