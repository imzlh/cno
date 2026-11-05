import type { BunServeHandler } from './serve';

export type BunServeHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type BunServeRoute = Response | BunServeHandler | false
    | Partial<Record<BunServeHttpMethod, Response | BunServeHandler>>;
export type BunServeRoutes = Record<string, BunServeRoute>;

export interface CompiledRoutes {
    match(request: Request): BunServeHandler | undefined;
    dispose(): void;
}

type Target = Response | BunServeHandler;
type ValidatedRoute = Target | false | Map<string, Target>;
type CompiledRoute = BunServeHandler | false | Map<string, BunServeHandler>;

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
// Static routes are retained in memory; larger or streaming bodies belong in a handler.
const MAX_STATIC_BODY_BYTES = 16 * 1024 * 1024;
const MAX_STATIC_BODY_CHUNKS = 16384;
// Response wraps Uint8Array bodies without copying in this host. Keep route
// snapshots private by copying one bounded chunk per pull instead of making a
// full-body copy for every concurrent request.
const STATIC_RESPONSE_CHUNK_BYTES = 64 * 1024;
// Keep route-table snapshots bounded even when many static routes are present.
// This process-wide budget also covers the brief overlap during reload().
const MAX_STATIC_SNAPSHOT_BYTES = 32 * 1024 * 1024;

interface FinalizableResponseState {
    finish(): void;
}

class SnapshotBudget {
    private reserved = 0;

    reserve(bytes: number): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('invalid static snapshot reservation');
        if (this.reserved + bytes > MAX_STATIC_SNAPSHOT_BYTES) {
            throw new RangeError(
                'Bun.serve: static route tables exceed 32 MiB of cached response bodies; use route handlers instead.',
            );
        }
        this.reserved += bytes;
    }

    release(bytes: number): void {
        this.reserved = Math.max(0, this.reserved - bytes);
    }
}

const snapshotBudget = new SnapshotBudget();
const staticResponseFinalizer = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<FinalizableResponseState>(state => state.finish())
    : undefined;

class SnapshotReservation {
    private held = 0;
    private released = false;

    reserve(bytes: number): void {
        if (this.released) throw new Error('Bun.serve: static snapshot was disposed.');
        snapshotBudget.reserve(bytes);
        this.held += bytes;
    }

    release(bytes: number): void {
        if (bytes <= 0) return;
        const amount = Math.min(bytes, this.held);
        snapshotBudget.release(amount);
        this.held -= amount;
    }

    releaseAll(): void {
        if (this.released) return;
        this.released = true;
        snapshotBudget.release(this.held);
        this.held = 0;
    }

    get bytes(): number {
        return this.held;
    }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
}

function validateTarget(value: unknown, path: string): Target {
    if (typeof value === 'function') return value as BunServeHandler;
    if (value instanceof Response) {
        if (value.bodyUsed || value.body?.locked) {
            throw new TypeError(`Bun.serve: static response for "${path}" is already used or locked.`);
        }
        if (value.status < 200 || value.status > 599) {
            throw new TypeError(`Bun.serve: static response for "${path}" has an unsupported status.`);
        }
        return value;
    }
    throw new TypeError(`Bun.serve: route "${path}" must contain a function or Response.`);
}

async function readStaticBody(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    reservation: SnapshotReservation,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; capacity: number }> {
    let bytes = new Uint8Array(0);
    let size = 0;
    let chunks = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (++chunks > MAX_STATIC_BODY_CHUNKS) {
                throw new RangeError('Bun.serve: static response exceeds 16384 chunks; use a route handler instead.');
            }
            if (!(value instanceof Uint8Array)) {
                throw new TypeError('Bun.serve: static response bodies must contain Uint8Array chunks.');
            }
            const nextSize = size + value.byteLength;
            if (nextSize > MAX_STATIC_BODY_BYTES) {
                throw new RangeError('Bun.serve: static response exceeds 16 MiB; use a route handler instead.');
            }
            if (nextSize > bytes.byteLength) {
                const oldCapacity = bytes.byteLength;
                const nextCapacity = Math.min(MAX_STATIC_BODY_BYTES, Math.max(1024, oldCapacity * 2, nextSize));
                // Account for both buffers while copying. Once the copy is
                // complete, release the old allocation's reservation.
                reservation.reserve(nextCapacity);
                try {
                    const grown = new Uint8Array(nextCapacity);
                    grown.set(bytes.subarray(0, size));
                    bytes = grown;
                } catch (error) {
                    reservation.release(nextCapacity);
                    throw error;
                }
                reservation.release(oldCapacity);
            }
            bytes.set(value, size);
            size = nextSize;
        }
    } catch (error) {
        reservation.releaseAll();
        // A tee's other branch belongs to the caller and may never be consumed.
        // Waiting for cancellation here would leave the request hanging.
        void reader.cancel(error).catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
    // Keep the geometrically grown backing store; a subarray avoids another
    // full-size allocation while exposing only the actual body bytes.
    return { bytes: bytes.subarray(0, size), capacity: reservation.bytes };
}

class StaticResponseState implements FinalizableResponseState {
    private offset = 0;
    private finished = false;
    private finalizerToken: object | undefined;

    constructor(
        private snapshot: Uint8Array<ArrayBuffer> | undefined,
        private readonly onDone: () => void,
    ) {}

    finish(): void {
        if (this.finished) return;
        this.finished = true;
        this.snapshot = undefined;
        const token = this.finalizerToken;
        this.finalizerToken = undefined;
        if (token) staticResponseFinalizer?.unregister(token);
        this.onDone();
    }

    setFinalizerToken(token: object): void {
        this.finalizerToken = token;
    }

    pull(controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>): void {
        if (this.finished) return;
        const cached = this.snapshot;
        if (!cached || this.offset >= cached.byteLength) {
            this.finish();
            controller.close();
            return;
        }
        try {
            const end = Math.min(this.offset + STATIC_RESPONSE_CHUNK_BYTES, cached.byteLength);
            // Never expose a view into the cached route snapshot: callers
            // are allowed to mutate chunks returned by body readers.
            const chunk = new Uint8Array(end - this.offset);
            chunk.set(cached.subarray(this.offset, end));
            this.offset = end;
            controller.enqueue(chunk);
            if (this.offset >= cached.byteLength) {
                this.finish();
                controller.close();
            }
        } catch (error) {
            this.finish();
            controller.error(error);
        }
    }
}

function snapshotResponseStream(
    snapshot: Uint8Array<ArrayBuffer>,
    onDone: () => void,
): { stream: ReadableStream<Uint8Array<ArrayBuffer>>; state: StaticResponseState } {
    // Finalization tracks the stream, not its Response wrapper: a caller may
    // keep reading response.body after the Response itself becomes unreachable.
    const state = new StaticResponseState(snapshot, onDone);

    const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
            state.pull(controller);
        },
        cancel() {
            state.finish();
        },
    });
    return { stream, state };
}

function compileTarget(target: Target, disposers: Array<() => void>): BunServeHandler {
    if (typeof target === 'function') return target;
    const init = {
        status: target.status,
        statusText: target.statusText,
        headers: new Headers(target.headers),
    };
    const snapshot = target.clone();
    if (snapshot.body === null) return () => new Response(null, init);

    const reader = snapshot.body.getReader();
    const reservation = new SnapshotReservation();
    let body: Uint8Array<ArrayBuffer> | undefined;
    let activeRequests = 0;
    let disposed = false;
    const release = () => {
        if (!disposed || activeRequests !== 0) return;
        body = undefined;
        reservation.releaseAll();
    };
    // Drain eagerly so a caller reading the original cannot fill an idle tee.
    const pending = readStaticBody(reader, reservation).then(result => {
        if (disposed && activeRequests === 0) {
            reservation.releaseAll();
            return;
        }
        body = result.bytes;
    }).finally(() => {
        release();
    });
    void pending.catch(() => {});
    disposers.push(() => {
        disposed = true;
        if (activeRequests === 0) void reader.cancel().catch(() => {});
        release();
    });
    return async request => {
        activeRequests++;
        let streamOwned = false;
        try {
            await pending;
            if (!body) throw new Error('Bun.serve: static response body was released.');
            // HEAD preserves the static status/headers without allocating a
            // throwaway copy that the HTTP host would discard immediately.
            if (request.method === 'HEAD') return new Response(null, init);
            const responseState = snapshotResponseStream(body, () => {
                activeRequests--;
                release();
            });
            let response: Response;
            try {
                response = new Response(responseState.stream, init);
            } catch (error) {
                // `finish()` owns the active-request decrement on this path.
                streamOwned = true;
                responseState.state.finish();
                throw error;
            }
            // Keep the snapshot alive until the response body is consumed or
            // cancelled, including when reload()/stop() replaced the table.
            if (staticResponseFinalizer) {
                const finalizerToken = {};
                responseState.state.setFinalizerToken(finalizerToken);
                staticResponseFinalizer.register(responseState.stream, responseState.state, finalizerToken);
            }
            streamOwned = true;
            return response;
        } finally {
            if (!streamOwned) {
                activeRequests--;
                release();
            }
        }
    };
}

class RouteResources {
    readonly disposers: Array<() => void> = [];
    readonly finalizerToken = {};

    dispose(): void {
        for (const cleanup of this.disposers.splice(0)) cleanup();
        routeFinalizer?.unregister(this.finalizerToken);
    }
}

const routeFinalizer = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<RouteResources>(resources => resources.dispose())
    : undefined;

export function compileRoutes(value: unknown): CompiledRoutes {
    if (!isRecord(value)) {
        throw new TypeError('Bun.serve: routes must be an object.');
    }
    const validated = new Map<string, ValidatedRoute>();
    for (const path of Reflect.ownKeys(value)) {
        if (typeof path !== 'string' || !path.startsWith('/') || /[:*?#]/.test(path)) {
            throw new TypeError('Bun.serve: routes support only exact paths beginning with "/"; '
                + 'parameters, wildcards, queries, and fragments are unsupported.');
        }
        // Request URLs normalize dot segments and escape non-path characters.
        if (/%(?![0-9A-Fa-f]{2})/.test(path)
            || new URL(`http://route.invalid${path}`).pathname !== path) {
            throw new TypeError(`Bun.serve: route "${path}" must be a canonical, percent-encoded URL pathname.`);
        }
        const route: unknown = Reflect.get(value, path);
        if (route === false) {
            validated.set(path, false);
        } else if (typeof route === 'function' || route instanceof Response) {
            validated.set(path, validateTarget(route, path));
        } else if (isRecord(route)) {
            const methods = new Map<string, Target>();
            for (const method of Reflect.ownKeys(route)) {
                if (typeof method !== 'string' || !METHODS.has(method)) {
                    throw new TypeError(`Bun.serve: unsupported route method "${String(method)}" for "${path}". `
                        + 'BunFile, HTML bundles, and directory routes are not supported.');
                }
                methods.set(method, validateTarget(Reflect.get(route, method), path));
            }
            validated.set(path, methods);
        } else {
            throw new TypeError(`Bun.serve: route "${path}" must be a function, Response, method map, or false.`);
        }
    }

    // Validate the whole table before cloning a body or installing any handler.
    const routes = new Map<string, CompiledRoute>();
    const resources = new RouteResources();
    try {
        for (const [path, route] of validated) {
            if (route === false) routes.set(path, false);
            else if (route instanceof Map) {
                const methods = new Map<string, BunServeHandler>();
                for (const [method, target] of route) {
                    methods.set(method, compileTarget(target, resources.disposers));
                }
                routes.set(path, methods);
            } else routes.set(path, compileTarget(route, resources.disposers));
        }
    } catch (error) {
        resources.dispose();
        throw error;
    }
    const compiled: CompiledRoutes = {
        dispose: () => resources.dispose(),
        match(request) {
            const route = routes.get(new URL(request.url).pathname);
            if (route instanceof Map) {
                return route.get(request.method) ?? (request.method === 'HEAD' ? route.get('GET') : undefined);
            }
            return route || undefined;
        },
    };
    // The held resources never reference `compiled`, so the finalizer remains
    // a valid fallback when callers abandon a server without stopping it.
    routeFinalizer?.register(compiled, resources, resources.finalizerToken);
    return compiled;
}
