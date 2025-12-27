import { errors } from "./01_errors";
import packageJson from '../../package.json';

const os = import.meta.use('os');
const sys = import.meta.use('sys');
const engine = import.meta.use('engine');
const signal = import.meta.use('signal');
const console = import.meta.use('console');

function notSupported(): never{
    throw new errors.NotSupported("Not supported");
}

const signalMap: Record<string, Map<() => void, CModuleSignals.SignalHandler>> = {};

function safeGetEnv(env: string){
    try{
        return os.getenv(env);
    }catch{}
    return null;
}

Object.defineProperty(globalThis, "Deno", {
    value: {
        errors,

        pid: os.pid,
        ppid: os.ppid,
        args: sys.args.slice(1),    // remove self
        env: {
            get: safeGetEnv,
            set: os.setenv,
            has: (key: string) => safeGetEnv(key)!== null,
            delete: (key: string) => os.unsetenv(key),
            toObject() {
                const env = {} as Record<string, string>;
                for (const key of os.envKeys()) {
                    env[key] = os.getenv(key)!;
                }
                return env;
            },
        },
        exit: code => os.exit(code == 0 ? Deno.exitCode : code ?? 0),
        exitCode: 0,
        build: {
            arch: os.uname().machine,
            os: sys.platform,
            standalone: false,
            target: `${os.uname().machine}-unknown-${sys.platform}`,
            vendor: "cno"
        },
        version: {
            deno: packageJson.version,
            // note: this is not real!
            v8: engine.versions.quickjs,
            typescript: "5.9.0-sucrase",
        },
        cwd: () => os.cwd,
        chdir: (dir: string) => os.chdir(dir),
        mainModule: '',  // TODO
        execPath: () => sys.exePath,
        noColor: safeGetEnv("NO_COLOR") === "1",
        memoryUsage: () => {
            const memory = os.memoryUsage();
            return {
                external: memory["vm.used"],
                // note: qjs does not have heap
                heapTotal: memory['used'],
                heapUsed: memory['used'],
                rss: memory["os.rss"],
            }
        },
        systemMemoryInfo(){
            const memory = os.memoryUsage();
            return {
                total: memory["os.total"],
                free: memory["os.free"],
                available: memory["os.free"],
                // these are not supported by cjs
                buffers: 0,
                cached: 0,
                swapTotal: 0,
                swapFree: 0
            };
        },
        hostname: () => os.hostname,
        loadavg: os.loadavg,
        osRelease: () => os.uname().release,
        osUptime: () => os.uptime(),

        // permission eco
        permissions: {
            query(desc){ return Promise.resolve(this.querySync(desc)); },
            querySync: desc => ({
                    state: 'granted',
                    addEventListener: () => void 0,
                    removeEventListener: () => void 0,
                    dispatchEvent: () => true,
                    onchange: null,
                    partial: false,
                }),
            request: notSupported,
            requestSync: notSupported,
            revoke: notSupported,
            revokeSync: notSupported,
        },
        // todo: PermissionStatus, Permissions, test, bench

        addSignalListener(sig, handler){
            // @ts-ignore
            const sigint = signal.signals[sig];
            if (typeof sigint != 'number')
                throw new Error(`Invalid signal: ${sig}`);
            if (signalMap[sig]?.has(handler))
                return;
            const ret = signal.signal(sigint, handler);
            if (!signalMap[sig]) signalMap[sig] = new Map();
            signalMap[sig].set(handler, ret);
        },

        removeSignalListener(sig, handler){
            // @ts-ignore
            const sigint = signal.signals[sig];
            if (typeof sigint != 'number')
                throw new Error(`Invalid signal: ${sig}`);
            const map = signalMap[sig];
            if (!map) return;
            const ret = map.get(handler);
            if (ret) ret.close();
        },

        inspect(obj, opt){
            return console.inspect(obj);
        },

        refTimer(id){
            // todo?
        },
        unrefTimer(id){
            // todo?
        },

        uid(){
            // fixme: this is not work well when suid
            return os.userInfo.userId;
        },
        gid(){
            return os.userInfo.groupId;
        }
    } as Partial<typeof Deno>,
    writable: false,
    enumerable: true,
    configurable: true,
})

// then import polyfills
await import('./02_fs');
await import('./03_fopen');
await import('./04_stdio');
await import('./05_net');
await import('./06_process');
await import('./07_http');
await import('./08_serve');