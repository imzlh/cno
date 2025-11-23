import { errors } from "./01_errors.js";
import packageJson from '../../package.json';

const os = import.meta.use('os');
const sys = import.meta.use('sys');
const engine = import.meta.use('engine');

function notSupported(): never{
    throw new errors.NotSupported("Not supported");
}

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
        args: sys.args,
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
            target: "unknown",
            vendor: "unknown",
        },
        version: {
            deno: packageJson.version,
            // note: this is not real!
            v8: engine.versions.quickjs,
            typescript: "3.9.2",
        },
        cwd: () => os.cwd,
        chdir: (dir: string) => os.chdir(dir),
        mainModule: '',  // TODO
        execPath: () => sys.exePath,
        noColor: safeGetEnv("NO_COLOR") === "1",
        memoryUsage: () => {
            // TODO
            return {
                external: 0,
                heapTotal: 0,
                heapUsed: 0,
                rss: 0,
            }
        },
        hostname: () => os.hostname,
        loadavg: os.loadavg,
        // TODO: not supported by cjs
        networkInterfaces: () => [],
        osRelease: () => os.uname().release,
        osUptime: () => os.uptime(),
        umask: () => notSupported(),

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
        // todo: PermissionStatus, Permissions,
    } as Partial<typeof Deno>,
    writable: false,
    enumerable: true,
    configurable: true,
})

// then import polyfills
await import('./fs');