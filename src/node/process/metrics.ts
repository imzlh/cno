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

let lastCpuUsage = { user: 0, system: 0 };

export function cpuUsage(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage {
    const cpus = os.cpuInfo();
    if (cpus.length === 0) return { user: 0, system: 0 };

    // Aggregate across all cores
    let totalUser = 0, totalNice = 0, totalSys = 0, totalIdle = 0;
    for (const cpu of cpus) {
        totalUser += cpu.times.user;
        totalNice += cpu.times.nice;
        totalSys += cpu.times.sys;
        totalIdle += cpu.times.idle;
    }

    const current = {
        user: (totalUser + totalNice) * 1e6,  // ms → μs
        system: totalSys * 1e6,
    };

    if (previousValue) {
        return {
            user: current.user - (previousValue.user || 0),
            system: current.system - (previousValue.system || 0),
        };
    }

    // First call: return delta since last call, or zero if first ever
    const result = {
        user: current.user - lastCpuUsage.user,
        system: current.system - lastCpuUsage.system,
    };
    lastCpuUsage = { user: current.user, system: current.system };
    return result;
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
