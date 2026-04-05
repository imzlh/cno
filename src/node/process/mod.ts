/**
 * Node.js process 模块
 * 提供当前 Node.js 进程的信息和控制能力
 */

const os = import.meta.use('os');
const sys = import.meta.use('sys');
const engine = import.meta.use('engine');
const signal = import.meta.use('signals');
const proc = import.meta.use('process');

// ============================================================================
// 辅助函数
// ============================================================================

function safeGetEnv(env: string): string | undefined {
    try {
        return os.getenv(env) ?? undefined;
    } catch {
        return undefined;
    }
}

// ============================================================================
// hrtime 实现
// ============================================================================

const hrtimeStart = Date.now();

function hrtime(time?: [number, number]): [number, number] {
    const now = Date.now() - hrtimeStart;
    const seconds = Math.floor(now / 1000);
    const nanoseconds = (now % 1000) * 1e6;

    if (time) {
        const diffSeconds = seconds - time[0];
        const diffNanoseconds = nanoseconds - time[1];
        if (diffNanoseconds < 0) {
            return [diffSeconds - 1, diffNanoseconds + 1e9];
        }
        return [diffSeconds, diffNanoseconds];
    }

    return [seconds, nanoseconds];
}

hrtime.bigint = function (): bigint {
    const [seconds, nanoseconds] = hrtime();
    return BigInt(seconds) * BigInt(1e9) + BigInt(nanoseconds);
};

// ============================================================================
// memoryUsage 实现
// ============================================================================

function memoryUsage(): NodeJS.MemoryUsage {
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

// ============================================================================
// cpuUsage 实现
// ============================================================================

let lastCpuTime = Date.now();

function cpuUsage(previousValue?: NodeJS.CpuUsage): NodeJS.CpuUsage {
    const now = Date.now();
    const diff = now - lastCpuTime;

    if (previousValue) {
        return {
            user: diff * 1000 - previousValue.system,
            system: previousValue.system,
        };
    }

    return {
        user: diff * 1000,
        system: 0,
    };
}

// ============================================================================
// 信号处理
// ============================================================================

const signalMap: Map<NodeJS.Signals, Map<() => void, CModuleSignals.SignalHandler>> = new Map();

function addSignalListener(signalName: NodeJS.Signals, listener: () => void): void {
    // @ts-ignore
    const sigint = signal.signals[signalName];
    if (typeof sigint !== 'number') {
        throw new Error(`Invalid signal: ${signalName}`);
    }

    if (!signalMap.has(signalName)) {
        signalMap.set(signalName, new Map());
    }

    const map = signalMap.get(signalName)!;
    if (map.has(listener)) {
        return;
    }

    const ret = signal.signal(sigint, listener);
    map.set(listener, ret);
}

function removeSignalListener(signalName: NodeJS.Signals, listener: () => void): void {
    // @ts-ignore
    const sigint = signal.signals[signalName];
    if (typeof sigint !== 'number') {
        throw new Error(`Invalid signal: ${signalName}`);
    }

    const map = signalMap.get(signalName);
    if (!map) return;

    const ret = map.get(listener);
    if (ret) {
        ret.close();
        map.delete(listener);
    }
}

// ============================================================================
// 环境变量
// ============================================================================

const envProxy = new Proxy({} as NodeJS.ProcessEnv, {
    get(_, key: string): string | undefined {
        return safeGetEnv(key);
    },
    set(_, key: string, value: string): boolean {
        os.setenv(key, value);
        return true;
    },
    has(_, key: string): boolean {
        return safeGetEnv(key) !== undefined;
    },
    deleteProperty(_, key: string): boolean {
        os.unsetenv(key);
        return true;
    },
    ownKeys(): string[] {
        return os.envKeys();
    },
    getOwnPropertyDescriptor(_, key: string): PropertyDescriptor | undefined {
        const value = safeGetEnv(key);
        if (value === undefined) return undefined;
        return {
            enumerable: true,
            configurable: true,
            value,
        };
    },
});

// ============================================================================
// Process 对象
// ============================================================================

export const process: NodeJS.Process = {
    // 标准流 - 简化实现
    stdout: null as any,
    stderr: null as any,
    stdin: null as any,

    // 命令行参数
    argv: [sys.exePath, ...sys.args.slice(1)],
    argv0: sys.args[0] ?? sys.exePath,
    execArgv: [],

    // 进程信息
    pid: os.pid,
    ppid: os.ppid,

    // 平台信息
    arch: (() => {
        const machine = os.uname().machine;
        switch (machine) {
            case 'x86_64':
            case 'amd64':
                return 'x64';
            case 'i386':
            case 'i686':
                return 'ia32';
            case 'aarch64':
            case 'arm64':
                return 'arm64';
            case 'arm':
                return 'arm';
            default:
                return machine as NodeJS.Architecture;
        }
    })(),

    platform: (() => {
        const platform = sys.platform;
        switch (platform) {
            case 'linux':
                return 'linux';
            case 'darwin':
                return 'darwin';
            case 'win32':
                return 'win32';
            case 'freebsd':
                return 'freebsd';
            case 'openbsd':
                return 'openbsd';
            case 'sunos':
                return 'sunos';
            case 'aix':
                return 'aix';
            default:
                return platform as NodeJS.Platform;
        }
    })(),

    // 环境变量
    env: envProxy,

    // 工作目录
    cwd: () => os.cwd,
    chdir: (directory: string) => os.chdir(directory),

    // 退出
    exit: (code?: number): never => {
        os.exit(code ?? 0);
        throw new Error('unreachable');
    },

    exitCode: undefined,

    // 执行路径
    execPath: sys.exePath,

    // 标题
    title: 'node',

    // 版本信息
    version: 'v20.0.0',
    versions: {
        node: '20.0.0',
        v8: engine.versions.quickjs,
        modules: '120',
        http_parser: '2.0',
        uv: '1.0',
        zlib: '1.0',
        ares: '1.0',
        openssl: '3.0',
    },

    // 配置
    config: {
        target_defaults: {
            cflags: [],
            default_configuration: 'Release',
            defines: [],
            include_dirs: [],
            libraries: [],
        },
        variables: {
            clang: 0,
            host_arch: os.uname().machine,
            node_install_npm: true,
            node_install_waf: false,
            node_prefix: '/usr/local',
            node_shared_openssl: false,
            node_shared_v8: false,
            node_shared_zlib: false,
            node_use_dtrace: false,
            node_use_etw: false,
            node_use_openssl: true,
            target_arch: os.uname().machine,
            v8_no_strict_aliasing: 0,
            v8_use_snapshot: true,
            visibility: 'default',
        },
    },

    // 发布信息
    release: {
        name: 'node',
        lts: 'Iron',
    },

    // 特性
    features: {
        debug: false,
        uv: true,
        ipv6: true,
        tls: true,
        tls_alpn: true,
        tls_ocsp: true,
        tls_sni: true,
        cached_builtins: true,
        inspector: false,
        require_module: false,
        typescript: false,
    },

    // 内存使用
    memoryUsage,

    // CPU 使用
    cpuUsage,

    // 高精度时间
    hrtime,

    // 运行时间
    uptime: () => os.uptime(),

    // 信号处理
    on: ((event: string, listener: any) => {
        if (event.startsWith('SIG') || event.startsWith('sig')) {
            addSignalListener(event as NodeJS.Signals, listener);
        }
    }) as any,

    off: ((event: string, listener: any) => {
        if (event.startsWith('SIG') || event.startsWith('sig')) {
            removeSignalListener(event as NodeJS.Signals, listener);
        }
    }) as any,

    once: ((event: string, listener: any) => {
        const onceListener = () => {
            listener();
            removeSignalListener(event as NodeJS.Signals, onceListener);
        };
        addSignalListener(event as NodeJS.Signals, onceListener);
    }) as any,

    emit: ((event: string, ...args: any[]) => {
        // 简化实现
        return false;
    }) as any,

    addListener: ((event: string, listener: any) => {
        return process.on(event as NodeJS.Signals, listener);
    }) as any,

    removeListener: ((event: string, listener: any) => {
        return process.off(event as NodeJS.Signals, listener);
    }) as any,

    // 权限
    permission: {
        has: () => true,
    },

    // 报告
    report: {
        compact: false,
        directory: '',
        filename: '',
        getReport: () => ({}),
        reportOnFatalError: false,
        reportOnSignal: false,
        reportOnUncaughtException: false,
        excludeEnv: false,
        signal: 'SIGUSR2',
        writeReport: () => '',
    },

    // 资源使用
    resourceUsage: () => ({
        fsRead: 0,
        fsWrite: 0,
        involuntaryContextSwitches: 0,
        ipcReceived: 0,
        ipcSent: 0,
        majorPageFault: 0,
        maxRSS: 0,
        minorPageFault: 0,
        sharedMemorySize: 0,
        signalsCount: 0,
        swappedOut: 0,
        systemCPUTime: 0,
        unsharedDataSize: 0,
        unsharedStackSize: 0,
        userCPUTime: 0,
        voluntaryContextSwitches: 0,
    }),

    // 警告
    emitWarning: (warning: string | Error, options?: any) => {
        console.warn(warning);
    },

    // 其他方法
    getuid: () => os.userInfo.userId,
    getgid: () => os.userInfo.groupId,
    geteuid: () => os.userInfo.userId,
    getegid: () => os.userInfo.groupId,
    setuid: () => { throw new Error('setuid is not supported'); },
    setgid: () => { throw new Error('setgid is not supported'); },
    seteuid: () => { throw new Error('seteuid is not supported'); },
    setegid: () => { throw new Error('setegid is not supported'); },
    setgroups: () => { throw new Error('setgroups is not supported'); },

    // umask
    umask: (mask?: number | string) => {
        return 0o022;
    },

    // nextTick
    nextTick: (callback: Function, ...args: any[]) => {
        queueMicrotask(() => callback(...args));
    },

    // 断开
    connected: false,
    disconnect: () => {},

    // 发送消息
    send: () => false,

    // 通道
    channel: null as any,

    // 杀进程
    kill: (pid: number, signal?: string | number) => {
        proc.kill(pid, signal as any);
        return true;
    },

    // abort
    abort: (): never => {
        os.exit(134); // SIGABRT
        throw new Error('unreachable')
    },

    // 事件监听器数量
    listenerCount: () => 0,

    // 最大监听器
    getMaxListeners: () => 10,
    setMaxListeners: (n: number) => process,

    // 主模块
    mainModule: undefined,

    // 事件
    eventNames: () => [],
    prependListener: () => process,
    prependOnceListener: () => process,
    removeAllListeners: () => process,
    setUncaughtExceptionCaptureCallback: () => {},
    hasUncaughtExceptionCaptureCallback: () => false,

    // 缺失的属性
    debugPort: 5858,

    dlopen: (module: object, filename: string, flags?: number) => {
        throw new Error('process.dlopen is not supported');
    },

    finalization: {
        register: <T extends object>(ref: T, callback: (ref: T, event: "exit") => void) => {},
        registerBeforeExit: <T extends object>(ref: T, callback: (ref: T, event: "beforeExit") => void) => {},
        unregister: (ref: object) => {},
    },

    getActiveResourcesInfo: () => [],

    getBuiltinModule: (id: string) => {
        try {
            return require(id);
        } catch {
            return undefined;
        }
    },

    allowedNodeEnvironmentFlags: new Set([
        '--require', '-r', '--import', '--loader', '--inspect', '--inspect-brk',
        '--inspect-port', '--abort-on-uncaught-exception', '--no-deprecation',
        '--trace-deprecation', '--throw-deprecation', '--enable-source-maps',
    ]),

    throwDeprecation: false,
    traceDeprecation: false,
    noDeprecation: undefined,

    ref: (maybeRefable: any) => {},
    unref: (maybeRefable: any) => {},

    loadEnvFile: (path?: any) => {
        throw new Error('process.loadEnvFile is not supported');
    },

    sourceMapsEnabled: false,
    setSourceMapsEnabled: (value: boolean) => {},

    threadCpuUsage: (previousValue?: NodeJS.CpuUsage) => cpuUsage(previousValue),

    constrainedMemory: () => 0,
    availableMemory: () => 0,

    listeners: () => [],
    rawListeners: () => [],
};

export default process;
