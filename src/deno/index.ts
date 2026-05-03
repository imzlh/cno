import { errors } from "./01_errors";
import packageJson from '../../package.json';

const os = import.meta.use('os');
const engine = import.meta.use('engine');
const signal = import.meta.use('signals');
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

const testRegistry: Deno.TestDefinition[] = [];
const benchRegistry: Deno.BenchDefinition[] = [];
const beforeAllHooks: (() => void | Promise<void>)[] = [];
const beforeEachHooks: (() => void | Promise<void>)[] = [];
const afterEachHooks: (() => void | Promise<void>)[] = [];
const afterAllHooks: (() => void | Promise<void>)[] = [];
const failedTests: Deno.TestDefinition[] = [];

function createTestContext(name: string, origin: string, parent?: Deno.TestContext): Deno.TestContext {
    const ctx: Deno.TestContext = {
        name,
        origin,
        parent,
        async step(definitionOrName: Deno.TestStepDefinition | string | ((t: Deno.TestContext) => void | Promise<void>), fn?: (t: Deno.TestContext) => void | Promise<void>): Promise<boolean> {
            let stepDef: Deno.TestStepDefinition;
            
            if (typeof definitionOrName === 'string') {
                stepDef = { name: definitionOrName, fn: fn! };
            } else if (typeof definitionOrName === 'function') {
                const funcName = definitionOrName.name || 'anonymous step';
                stepDef = { name: funcName, fn: definitionOrName };
            } else {
                stepDef = definitionOrName;
            }
            
            if (stepDef.ignore) {
                console.warn(`  skip ${stepDef.name}`);
                return false;
            }
            
            const stepCtx = createTestContext(stepDef.name, origin, ctx);
            try {
                await stepDef.fn(stepCtx);
                console.info(`  ok ${stepDef.name}`);
                return true;
            } catch (e) {
                console.error(`  fail ${stepDef.name}`, e);
                failedTests.push(stepDef);
                return false;
            }
        }
    };
    return ctx;
}

function createBenchContext(name: string, origin: string): Deno.BenchContext {
    let startTime = 0;
    let timerActive = false;
    
    return {
        name,
        origin,
        start() {
            startTime = performance.now();
            timerActive = true;
        },
        end() {
            if (timerActive) {
                timerActive = false;
            }
        }
    };
}

function registerTest(def: Deno.TestDefinition): void {
    testRegistry.push(def);
}

function registerBench(def: Deno.BenchDefinition): void {
    benchRegistry.push(def);
}

function isTestDefinition(obj: unknown): obj is Deno.TestDefinition {
    return typeof obj === 'object' && obj !== null && 'fn' in obj && 'name' in obj;
}

function isBenchDefinition(obj: unknown): obj is Deno.BenchDefinition {
    return typeof obj === 'object' && obj !== null && 'fn' in obj && 'name' in obj;
}

function createTestFunction(): Deno.DenoTest {
    const testFn = (...args: unknown[]) => {
        let def: Deno.TestDefinition;
        
        if (args.length === 1) {
            const arg = args[0];
            if (isTestDefinition(arg)) {
                def = arg;
            } else if (typeof arg === 'function') {
                def = { name: arg.name || 'anonymous', fn: arg as (t: Deno.TestContext) => void | Promise<void> };
            } else {
                throw new TypeError('Invalid test definition');
            }
        } else if (args.length === 2) {
            const [nameOrOptions, fnOrOptions] = args;
            if (typeof nameOrOptions === 'string') {
                def = { 
                    name: nameOrOptions, 
                    fn: fnOrOptions as (t: Deno.TestContext) => void | Promise<void>
                };
            } else if (typeof nameOrOptions === 'object' && typeof fnOrOptions === 'function') {
                const opts = nameOrOptions as Omit<Deno.TestDefinition, 'fn' | 'name'>;
                const fn2 = fnOrOptions as (t: Deno.TestContext) => void | Promise<void>;
                def = {
                    name: fnOrOptions.name || 'anonymous',
                    fn: fn2,
                    ...opts
                };
            } else {
                throw new TypeError('Invalid test definition');
            }
        } else if (args.length === 3) {
            const [name, options, fn] = args;
            def = {
                name: name as string,
                fn: fn as (t: Deno.TestContext) => void | Promise<void>,
                ...(options as Omit<Deno.TestDefinition, 'fn' | 'name'>)
            };
        } else {
            throw new TypeError('Invalid test definition');
        }
        
        registerTest(def);
    };
    
    const testObj = Object.assign(testFn, {
        ignore: (...args: unknown[]) => {
            let def: Deno.TestDefinition;
            
            if (args.length === 1) {
                const arg = args[0];
                if (typeof arg === 'object' && arg !== null) {
                    def = { ...arg, ignore: true } as Deno.TestDefinition;
                } else if (typeof arg === 'function') {
                    def = { name: arg.name || 'anonymous', fn: arg as (t: Deno.TestContext) => void | Promise<void>, ignore: true };
                } else {
                    throw new TypeError('Invalid test definition');
                }
            } else if (args.length === 2) {
                const [nameOrOptions, fnOrOptions] = args;
                if (typeof nameOrOptions === 'string') {
                    def = { 
                        name: nameOrOptions, 
                        fn: fnOrOptions as (t: Deno.TestContext) => void | Promise<void>,
                        ignore: true
                    };
                } else if (typeof nameOrOptions === 'object' && typeof fnOrOptions === 'function') {
                    const opts = nameOrOptions as Omit<Deno.TestDefinition, 'fn' | 'name' | 'ignore'>;
                    const fn2 = fnOrOptions as (t: Deno.TestContext) => void | Promise<void>;
                    def = {
                        name: fnOrOptions.name || 'anonymous',
                        fn: fn2,
                        ignore: true,
                        ...opts
                    };
                } else {
                    throw new TypeError('Invalid test definition');
                }
            } else if (args.length === 3) {
                const [name, options, fn] = args;
                def = {
                    name: name as string,
                    fn: fn as (t: Deno.TestContext) => void | Promise<void>,
                    ignore: true,
                    ...(options as Omit<Deno.TestDefinition, 'fn' | 'name' | 'ignore'>)
                };
            } else {
                throw new TypeError('Invalid test definition');
            }
            registerTest(def);
        },
        
        only: (...args: unknown[]) => {
            let def: Deno.TestDefinition;
            
            if (args.length === 1) {
                const arg = args[0];
                if (typeof arg === 'object' && arg !== null) {
                    def = { ...arg, only: true } as Deno.TestDefinition;
                } else if (typeof arg === 'function') {
                    def = { name: arg.name || 'anonymous', fn: arg as (t: Deno.TestContext) => void | Promise<void>, only: true };
                } else {
                    throw new TypeError('Invalid test definition');
                }
            } else if (args.length === 2) {
                const [nameOrOptions, fnOrOptions] = args;
                if (typeof nameOrOptions === 'string') {
                    def = { 
                        name: nameOrOptions, 
                        fn: fnOrOptions as (t: Deno.TestContext) => void | Promise<void>,
                        only: true
                    };
                } else if (typeof nameOrOptions === 'object' && typeof fnOrOptions === 'function') {
                    const opts = nameOrOptions as Omit<Deno.TestDefinition, 'fn' | 'name' | 'only'>;
                    const fn2 = fnOrOptions as (t: Deno.TestContext) => void | Promise<void>;
                    def = {
                        name: fnOrOptions.name || 'anonymous',
                        fn: fn2,
                        only: true,
                        ...opts
                    };
                } else {
                    throw new TypeError('Invalid test definition');
                }
            } else if (args.length === 3) {
                const [name, options, fn] = args;
                def = {
                    name: name as string,
                    fn: fn as (t: Deno.TestContext) => void | Promise<void>,
                    only: true,
                    ...(options as Omit<Deno.TestDefinition, 'fn' | 'name' | 'only'>)
                };
            } else {
                throw new TypeError('Invalid test definition');
            }
            registerTest(def);
        },
        
        beforeAll: (fn: () => void | Promise<void>) => {
            beforeAllHooks.push(fn);
        },
        
        beforeEach: (fn: () => void | Promise<void>) => {
            beforeEachHooks.push(fn);
        },
        
        afterEach: (fn: () => void | Promise<void>) => {
            afterEachHooks.push(fn);
        },
        
        afterAll: (fn: () => void | Promise<void>) => {
            afterAllHooks.push(fn);
        }
    });
    
    return testObj as Deno.DenoTest;
}

function createBenchFunction(): {
    (b: Deno.BenchDefinition): void;
    (name: string, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (name: string, options: Omit<Deno.BenchDefinition, "fn" | "name">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (options: Omit<Deno.BenchDefinition, "fn">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    (options: Omit<Deno.BenchDefinition, "fn" | "name">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
} {
    const benchFn = (...args: unknown[]) => {
        let def: Deno.BenchDefinition;
        
        if (args.length === 1) {
            const arg = args[0];
            if (isBenchDefinition(arg)) {
                def = arg;
            } else if (typeof arg === 'function') {
                def = { name: arg.name || 'anonymous', fn: arg as (b: Deno.BenchContext) => void | Promise<void> };
            } else {
                throw new TypeError('Invalid bench definition');
            }
        } else if (args.length === 2) {
            const [nameOrOptions, fnOrOptions] = args;
            if (typeof nameOrOptions === 'string') {
                def = { 
                    name: nameOrOptions, 
                    fn: fnOrOptions as (b: Deno.BenchContext) => void | Promise<void>
                };
            } else if (typeof nameOrOptions === 'object' && typeof fnOrOptions === 'function') {
                const opts = nameOrOptions as Omit<Deno.BenchDefinition, 'fn' | 'name'>;
                const fn2 = fnOrOptions as (b: Deno.BenchContext) => void | Promise<void>;
                def = {
                    name: fnOrOptions.name || 'anonymous',
                    fn: fn2,
                    ...opts
                };
            } else {
                throw new TypeError('Invalid bench definition');
            }
        } else if (args.length === 3) {
            const [name, options, fn] = args;
            def = {
                name: name as string,
                fn: fn as (b: Deno.BenchContext) => void | Promise<void>,
                ...(options as Omit<Deno.BenchDefinition, 'fn' | 'name'>)
            };
        } else {
            throw new TypeError('Invalid bench definition');
        }
        
        registerBench(def);
    };
    
    return benchFn as {
        (b: Deno.BenchDefinition): void;
        (name: string, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
        (fn: (b: Deno.BenchContext) => void | Promise<void>): void;
        (name: string, options: Omit<Deno.BenchDefinition, "fn" | "name">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
        (options: Omit<Deno.BenchDefinition, "fn">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
        (options: Omit<Deno.BenchDefinition, "fn" | "name">, fn: (b: Deno.BenchContext) => void | Promise<void>): void;
    };
}

const uname = os.uname();
Object.defineProperty(globalThis, "Deno", {
    value: {
        errors,

        pid: os.pid,
        ppid: os.ppid,
        args: os.args.slice(1),    // remove self
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
            arch: uname.machine,
            os: uname.sysname,
            standalone: false,
            target: `${uname.machine}-unknown-${os.uname().sysname}`,
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
        get mainModule(){
            // @ts-ignore - cts api
            return globalThis.__mainScript; 
        },
        execPath: () => os.exePath,
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
        hostname: () => os.hostName,
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

        inspect(obj: any, opt){
            return console.inspect(obj, {
                colors: opt?.colors ?? Deno.noColor,
                depth: opt?.depth ?? undefined,
                showHidden: opt?.showHidden ?? false
            });
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
        },

        test: createTestFunction(),
        bench: createBenchFunction(),
        async __startTest(){
            const tctx = createTestContext('main', '<core>');
            for (const testItem of testRegistry) try {
                await tctx.step(testItem);
            } catch (e) {
                console.error(`  fail ${testItem.name}`);
                console.error(e);
            }
            const bctx = createBenchContext('main', '<core>');
            bctx.start();
            for (const benchItem of benchRegistry) try {
                await benchItem.fn(bctx);
            } catch (e) {
                console.error(`  fail ${benchItem.name}`);
                console.error(e);
            }
            bctx.end();
            if (failedTests.length > 0) {
                console.error('Failed tests:');
                for (const failed of failedTests) {
                    console.error(`  ${failed.name}`);
                }
            }
            return failedTests.length === 0;
        }
    } as Partial<typeof Deno>,
    writable: false,
    enumerable: true,
    configurable: true,
})

// then import polyfills
await import('./02_fs');
await import('./03_fopen');
export const { stdin, stdout, stderr } = await import('./04_stdio');
await import('./05_net');
await import('./06_process');
await import('./07_http');
await import('./08_serve');

// unstable APIs
await import('./kv');
await import('./ffi');