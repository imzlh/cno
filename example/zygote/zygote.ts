const processNative = import.meta.use('process');
const os = import.meta.use('os');

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export type ZygoteSignal = typeof STOP_SIGNALS[number];

export interface ZygoteChildContext {
    readonly role: string;
    readonly pid: number;
    readonly ppid: number;
    readonly signal: AbortSignal;
}

export interface ZygoteRole {
    readonly name: string;
    readonly run: (context: ZygoteChildContext) => void | Promise<void>;
}

export interface ZygoteChild {
    readonly role: string;
    readonly pid: number;
}

export interface ZygoteParentContext {
    readonly pid: number;
    readonly children: readonly ZygoteChild[];
}

export interface ZygoteOptions {
    readonly roles: readonly ZygoteRole[];
    readonly shutdownTimeoutMs?: number;
    /** Called after every role has been forked and parent signal handlers are
     * installed. Child services may not be listening yet. A pending hook does
     * not prevent the supervisor from finishing an already-complete shutdown. */
    readonly onForked?: (
        context: ZygoteParentContext,
    ) => void | PromiseLike<void>;
}

export interface ZygoteChildResult extends ZygoteChild {
    readonly status: CModuleProcess.ExitInfo;
}

export type ZygoteStopReason =
    | {
        readonly type: 'signal';
        readonly signal: ZygoteSignal;
    }
    | {
        readonly type: 'child-exit';
        readonly role: string;
        readonly pid: number;
        readonly status: CModuleProcess.ExitInfo;
    };

export interface ZygoteResult {
    readonly reason: ZygoteStopReason;
    readonly forced: boolean;
    readonly exitCode: number;
    readonly children: readonly ZygoteChildResult[];
}

export type ZygoteServeOptions = Omit<Deno.ServeTcpOptions, 'signal'> & {
    readonly signal?: never;
};

interface ParentChild {
    readonly role: ZygoteRole;
    process: CModuleProcess.ForkedProcess | null;
    active: boolean;
}

interface ValidatedOptions {
    readonly roles: readonly ZygoteRole[];
    readonly shutdownTimeoutMs: number;
    readonly onForked?: (
        context: ZygoteParentContext,
    ) => void | PromiseLike<void>;
}

function validateOptions(options: ZygoteOptions): ValidatedOptions {
    if (os.platform !== 'linux') {
        throw new Error('runZygote() requires Linux');
    }
    if (!options || !Array.isArray(options.roles) || options.roles.length === 0) {
        throw new TypeError('runZygote() requires at least one role');
    }

    const names = new Set<string>();
    const roles = options.roles.map((role, index): ZygoteRole => {
        if (!role || typeof role !== 'object') {
            throw new TypeError(`roles[${index}] must be an object`);
        }
        if (typeof role.name !== 'string' || role.name.length === 0) {
            throw new TypeError(`roles[${index}].name must be a non-empty string`);
        }
        if (names.has(role.name)) {
            throw new TypeError(`duplicate zygote role: ${role.name}`);
        }
        if (typeof role.run !== 'function') {
            throw new TypeError(`roles[${index}].run must be a function`);
        }
        names.add(role.name);
        return Object.freeze({ name: role.name, run: role.run });
    });

    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) {
        throw new TypeError('shutdownTimeoutMs must be a positive integer');
    }
    if (options.onForked !== undefined && typeof options.onForked !== 'function') {
        throw new TypeError('onForked must be a function');
    }

    return {
        roles: Object.freeze(roles),
        shutdownTimeoutMs,
        onForked: options.onForked,
    };
}

function cleanupPartialFork(children: readonly ParentChild[]): void {
    for (const child of children) {
        if (!child.process || !child.active) continue;
        try {
            child.process.kill('SIGKILL');
        } catch {
            // The child may already have exited.
        }
    }
    for (const child of children) {
        if (!child.process) continue;
        try {
            child.process.waitSync();
        } catch {
            // Preserve the error which interrupted the fork sequence.
        } finally {
            child.active = false;
        }
    }
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.stack ?? error.message;
    return String(error);
}

async function runChild(role: ZygoteRole): Promise<never> {
    const controller = new AbortController();
    const listeners: Array<{ signal: ZygoteSignal; listener: () => void }> = [];
    let exitCode = 0;

    try {
        for (const signal of STOP_SIGNALS) {
            const listener = () => controller.abort(signal);
            Deno.addSignalListener(signal, listener);
            listeners.push({ signal, listener });
        }

        const context: ZygoteChildContext = Object.freeze({
            role: role.name,
            pid: os.pid,
            ppid: os.ppid,
            signal: controller.signal,
        });
        await role.run(context);
    } catch (error) {
        exitCode = 1;
        console.error(`[zygote child:${role.name}] ${errorText(error)}`);
    } finally {
        for (const { signal, listener } of listeners) {
            Deno.removeSignalListener(signal, listener);
        }
    }

    os.exit(exitCode);
    throw new Error('os.exit() returned unexpectedly');
}

/**
 * Start one HTTP server owned by a zygote child.
 *
 * The helper checks for an already-aborted child signal before binding, then
 * connects the signal after creating the server. The second check closes the
 * race between those two operations.
 */
export async function serveHttp(
    context: ZygoteChildContext,
    options: ZygoteServeOptions,
    handler: Deno.ServeHandler<Deno.NetAddr>,
): Promise<void> {
    if (context.signal.aborted) return;

    const server = Deno.serve(options, handler);
    let notifyAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
        notifyAbort = resolve;
    });
    let shutdownPromise: Promise<void> | undefined;

    const shutdown = () => {
        shutdownPromise ??= server.shutdown();
        notifyAbort();
    };

    context.signal.addEventListener('abort', shutdown, { once: true });
    if (context.signal.aborted) shutdown();

    try {
        await Promise.race([server.finished, aborted]);
        if (shutdownPromise) await shutdownPromise;
        else await server.finished;
    } finally {
        context.signal.removeEventListener('abort', shutdown);
    }
}

/**
 * Fork every role before installing parent-side waiters, signals, or timers.
 * A child never returns from this function; the parent returns after every
 * child has been reaped.
 */
export async function runZygote(options: ZygoteOptions): Promise<ZygoteResult> {
    const validated = validateOptions(options);
    // Allocate every ownership slot before the first fork. In particular, an
    // allocation failure after fork() returns must not occur before the new
    // child has somewhere from which the parent can kill and reap it.
    const children: ParentChild[] = validated.roles.map((role) => ({
        role,
        process: null,
        active: false,
    }));

    try {
        for (const slot of children) {
            const role = slot.role;
            const child = processNative.fork();
            if (child === null) {
                // Drop references to inherited handles for older siblings. The
                // native layer disowns their copied libuv timers in this child.
                children.length = 0;
                return await runChild(role);
            }
            slot.process = child;
            slot.active = true;
        }
    } catch (error) {
        cleanupPartialFork(children);
        throw error;
    }

    let activeCount = children.length;
    let stopReason: ZygoteStopReason | undefined;
    let forced = false;
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    let waitPromises: Promise<ZygoteChildResult>[] | undefined;

    const signalChildren = (signal: CModuleProcess.Signal) => {
        for (const child of children) {
            if (!child.process || !child.active) continue;
            try {
                child.process.kill(signal);
            } catch {
                // wait() remains the authority for the final status.
            }
        }
    };

    const forceStop = () => {
        if (forced || activeCount === 0) return;
        forced = true;
        signalChildren('SIGKILL');
    };

    const beginStop = (reason: ZygoteStopReason, signal: ZygoteSignal) => {
        if (stopReason) return;
        stopReason = reason;
        signalChildren(signal);
        try {
            shutdownTimer = setTimeout(forceStop, validated.shutdownTimeoutMs);
        } catch {
            forceStop();
        }
    };

    const installedSignals: Array<{ signal: ZygoteSignal; listener: () => void }> = [];
    try {
        // All children already exist, so parent-only libuv waiters are now safe
        // to create. Build every waiter before signal installation so even a
        // partially failed setup still has a complete async reap path.
        waitPromises = children.map(async (child): Promise<ZygoteChildResult> => {
            const process = child.process!;
            const status = await process.wait();
            if (child.active) {
                child.active = false;
                activeCount--;
            }
            const result = Object.freeze({
                role: child.role.name,
                pid: process.pid,
                status,
            });
            if (!stopReason) {
                beginStop({
                    type: 'child-exit',
                    role: result.role,
                    pid: result.pid,
                    status,
                }, 'SIGTERM');
            }
            return result;
        });

        for (const signal of STOP_SIGNALS) {
            const listener = () => {
                if (stopReason) {
                    forceStop();
                    return;
                }
                beginStop({ type: 'signal', signal }, signal);
            };
            Deno.addSignalListener(signal, listener);
            installedSignals.push({ signal, listener });
        }

        const parentContext = Object.freeze({
            pid: os.pid,
            children: Object.freeze(children.map((child) => Object.freeze({
                role: child.role.name,
                pid: child.process!.pid,
            }))),
        });
        const resultsPromise = Promise.all(waitPromises);
        let results: ZygoteChildResult[];

        if (validated.onForked) {
            const hookResult = Promise.resolve(validated.onForked(parentContext)).then(
                () => ({ type: 'hook-complete' } as const),
                (error: unknown) => ({ type: 'hook-error', error } as const),
            );
            const first = await Promise.race([
                resultsPromise.then((value) => ({ type: 'children', value } as const)),
                hookResult,
            ]);
            if (first.type === 'hook-error') throw first.error;
            results = first.type === 'children' ? first.value : await resultsPromise;
        } else {
            results = await resultsPromise;
        }

        const failedChild = results.find((child) => (
            child.status.exit_status !== 0 || child.status.term_signal !== null
        ));
        const exitCode = forced
            ? 1
            : stopReason!.type === 'child-exit'
            ? stopReason!.status.exit_status || 1
            : failedChild?.status.exit_status || (failedChild ? 1 : 0);
        return Object.freeze({
            reason: stopReason!,
            forced,
            exitCode,
            children: Object.freeze(results),
        });
    } catch (error) {
        // This also covers allocation failures during post-fork parent setup.
        // Synchronous reaping is the ownership backstop if waiter construction
        // or signal listener installation only partially ran.
        cleanupPartialFork(children);
        if (waitPromises) await Promise.allSettled(waitPromises);
        throw error;
    } finally {
        if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
        for (const { signal, listener } of installedSignals) {
            Deno.removeSignalListener(signal, listener);
        }
    }
}
