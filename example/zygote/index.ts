import {
    runZygote,
    serveHttp,
    type ZygoteResult,
    type ZygoteRole,
} from './zygote.ts';

const os = import.meta.use('os');

// Materialize the Node-compatible process object before fork, just as an
// Express application would. Its PID accessors must still be live in children.
const nodeProcess = (globalThis as typeof globalThis & {
    process: { readonly pid: number };
}).process;

if (os.platform !== 'linux') {
    console.error('zygote example requires Linux');
    os.exit(1);
}

interface RoleConfig {
    readonly name: string;
    readonly port: number;
    readonly message: string;
}

function integerEnvironment(name: string, fallback: number): number {
    const value = Number(Deno.env.get(name) ?? fallback);
    if (!Number.isSafeInteger(value)) {
        throw new TypeError(`${name} must be an integer`);
    }
    return value;
}

const basePort = integerEnvironment('CNO_ZYGOTE_BASE_PORT', 8780);
if (basePort < 1024 || basePort > 65534) {
    throw new RangeError('CNO_ZYGOTE_BASE_PORT must be between 1024 and 65534');
}

const shutdownTimeoutMs = integerEnvironment('CNO_ZYGOTE_SHUTDOWN_TIMEOUT_MS', 5_000);
if (shutdownTimeoutMs <= 0) {
    throw new RangeError('CNO_ZYGOTE_SHUTDOWN_TIMEOUT_MS must be positive');
}

const roleConfigs: readonly RoleConfig[] = Object.freeze([
    Object.freeze({ name: 'video', port: basePort, message: 'video parser placeholder' }),
    Object.freeze({ name: 'ai', port: basePort + 1, message: 'AI gateway placeholder' }),
]);

// This state is deliberately built before the first fork. It contains no
// native resources and is shared copy-on-write by both HTTP children.
const preloaded = Object.freeze({
    createdAt: new Date().toISOString(),
    routes: Object.freeze(['/health', '/']),
    signature: Array.from({ length: 128 }, (_, index) => (index * 17) % 251).join('-'),
});

function createRole(config: RoleConfig): ZygoteRole {
    return {
        name: config.name,
        async run(context) {
            let requests = 0;
            await serveHttp(context, {
                hostname: '127.0.0.1',
                port: config.port,
                onListen({ hostname, port }) {
                    console.log(
                        `[zygote child:${config.name}] pid=${os.pid} listening on http://${hostname}:${port}`,
                    );
                },
            }, (request) => {
                requests++;
                const url = new URL(request.url);
                if (url.pathname === '/health') {
                    return Response.json({
                        role: config.name,
                        pid: os.pid,
                        ppid: os.ppid,
                        denoPid: Deno.pid,
                        processPid: nodeProcess.pid,
                        requests,
                        preloadedAt: preloaded.createdAt,
                        signature: preloaded.signature,
                    });
                }
                return new Response(`${config.message}\n`, {
                    headers: { 'content-type': 'text/plain; charset=utf-8' },
                });
            });
        },
    };
}

function describeStop(result: ZygoteResult): string {
    if (result.reason.type === 'signal') return result.reason.signal;
    return `child-exit:${result.reason.role}`;
}

const result = await runZygote({
    roles: roleConfigs.map(createRole),
    shutdownTimeoutMs,
    onForked(parent) {
        const children = parent.children
            .map((child) => `${child.role}=${child.pid}`)
            .join(',');
        console.log(`[zygote parent] pid=${parent.pid} children=${children}`);
        console.log(`[zygote parent] preloadedAt=${preloaded.createdAt}`);
    },
});

for (const child of result.children) {
    console.log(
        `[zygote parent] role=${child.role} pid=${child.pid} `
        + `exit=${child.status.exit_status} signal=${child.status.term_signal ?? 'none'}`,
    );
}
console.log(`[zygote parent] stopped=${describeStop(result)} forced=${result.forced}`);
Deno.exitCode = result.exitCode;
