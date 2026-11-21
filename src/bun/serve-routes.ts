import type { BunFileLike } from './file';
import type { BunServeHandler } from './serve';

export type BunServeHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type BunServeRoute<T = unknown> = Response | BunServeHandler<T> | false | BunFileLike | BunServeDirectoryRoute
    | Partial<Record<BunServeHttpMethod, Response | BunServeHandler<T>>>;
export type BunServeRoutes<T = unknown> = Record<string, BunServeRoute<T>>;

/** Bun's DirectoryRouteOptions subset; the route key must end in "/*". */
export interface BunServeDirectoryRoute {
    dir: string;
    /** Accepted for Bun parity. This adapter resolves per request instead of caching stat results. */
    statCache?: boolean;
}

export interface CompiledRouteMatch {
    handler: BunServeHandler;
    params: Record<string, string>;
}

export interface CompiledRoutes {
    resolve(request: Request): CompiledRouteMatch | undefined;
    dispose(): void;
}

type Target = Response | BunServeHandler;
type ValidatedRoute = Target | false | Map<string, Target> | { readonly bunFile: BunFileServeDescriptor };
type CompiledRoute = BunServeHandler | false | Map<string, BunServeHandler>;

/** A route value the built-in set does not recognize; resolved once per table. */
export type ResolvedRouteValue = Target | false | Map<string, Target>;

export type ServeRouteValueResolver = (
    value: Record<PropertyKey, unknown>,
    path: string,
) => ResolvedRouteValue | undefined;

let routeValueResolver: ServeRouteValueResolver | undefined;

/**
 * Installed by the static-file support module (serve-static.ts) so that
 * serve.ts stays free of filesystem imports and can be bundled into pure-JS
 * unit test lanes.
 */
export function setServeRouteValueResolver(resolver: ServeRouteValueResolver | undefined): void {
    routeValueResolver = resolver;
}

/**
 * Cross-module BunFile recognition over a registered symbol protocol, the same
 * pattern as cno.blob.bytes: importing the BunFile class here would pull the
 * filesystem bindings into the pure-JS serve bundle.
 */
const bunFileServeTarget = Symbol.for('cno.bun-file.serve-target');

export interface BunFileServeDescriptor {
    readonly path: string;
    /** Registration-time existence snapshot; missing files stay 404 routes. */
    readonly exists: boolean;
    readonly contentType: string;
    stream(): ReadableStream<Uint8Array<ArrayBuffer>>;
}

function bunFileServeTargetOf(value: unknown): BunFileServeDescriptor | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    const targeter = Reflect.get(value, bunFileServeTarget);
    if (typeof targeter !== 'function') return undefined;
    const descriptor = Reflect.apply(targeter, value, []) as unknown;
    if (descriptor === null || typeof descriptor !== 'object') return undefined;
    return descriptor as BunFileServeDescriptor;
}

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
// Parameter and wildcard patterns match by a linear scan, so their count is
// bounded to keep per-request matching work and table memory predictable.
const MAX_ROUTE_PATTERNS = 1024;

type PatternSegment = { readonly kind: 'static'; readonly value: string }
    | { readonly kind: 'param'; readonly name: string };

/** Matching data shared by the pending and compiled pattern shapes. */
interface RoutePatternData {
    readonly segments: readonly PatternSegment[];
    readonly wildcard: boolean;
    readonly staticCount: number;
    readonly order: number;
    /** Reused match scratch: [start, end) spans per param segment. */
    readonly spans: number[];
}

interface PendingPattern extends RoutePatternData {
    route: ValidatedRoute;
}

interface CompiledPattern extends RoutePatternData {
    readonly route: CompiledRoute;
}

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
    throw new TypeError(`Bun.serve: route "${path}" must contain a function, Response, or BunFile.`);
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

interface StaticTargetInit {
    status: number;
    statusText: string;
    headers: Headers;
}

/** Compile a finite stream body into the eagerly buffered, budgeted snapshot handler. */
function compileSnapshotTarget(
    init: StaticTargetInit,
    body: ReadableStream | null,
    disposers: Array<() => void>,
): BunServeHandler {
    if (body === null) return () => new Response(null, init);

    const reader = body.getReader();
    const reservation = new SnapshotReservation();
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    let activeRequests = 0;
    let disposed = false;
    const release = () => {
        if (!disposed || activeRequests !== 0) return;
        bytes = undefined;
        reservation.releaseAll();
    };
    // Drain eagerly so a caller reading the original cannot fill an idle tee.
    const pending = readStaticBody(reader, reservation).then(result => {
        if (disposed && activeRequests === 0) {
            reservation.releaseAll();
            return;
        }
        bytes = result.bytes;
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
            if (!bytes) throw new Error('Bun.serve: static response body was released.');
            // HEAD preserves the static status/headers without allocating a
            // throwaway copy that the HTTP host would discard immediately.
            if (request.method === 'HEAD') return new Response(null, init);
            const responseState = snapshotResponseStream(bytes, () => {
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

function compileTarget(target: Target, disposers: Array<() => void>): BunServeHandler {
    if (typeof target === 'function') return target;
    const init = {
        status: target.status,
        statusText: target.statusText,
        headers: new Headers(target.headers),
    };
    const snapshot = target.clone();
    return compileSnapshotTarget(init, snapshot.body, disposers);
}

function compileBunFileTarget(descriptor: BunFileServeDescriptor, disposers: Array<() => void>): BunServeHandler {
    // BunFile routes 404 for files missing at registration, mirroring Bun's
    // per-request missing-file behavior for the common case.
    if (!descriptor.exists) return () => new Response(null, { status: 404 });
    const init: StaticTargetInit = {
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
    };
    if (descriptor.contentType) init.headers.set('content-type', descriptor.contentType);
    return compileSnapshotTarget(init, descriptor.stream(), disposers);
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

/**
 * Parse a pattern key into whole-segment matchers. Bun supports ":" parameters
 * that capture one segment and a trailing "*" wildcard; mixed segments such as
 * "/a:b" or mid-path wildcards are unsupported by its router.
 */
function parseRoutePattern(key: string): { segments: PatternSegment[]; wildcard: boolean; staticCount: number } {
    const parts = key.split('/');
    const segments: PatternSegment[] = [];
    let wildcard = false;
    const names = new Set<string>();
    for (let index = 1; index < parts.length; index++) {
        const part = parts[index]!;
        const last = index === parts.length - 1;
        if (part === '*') {
            if (!last) {
                throw new TypeError(`Bun.serve: route "${key}" supports "*" only as the final segment.`);
            }
            wildcard = true;
            continue;
        }
        if (part.length === 0) {
            throw new TypeError(`Bun.serve: route "${key}" cannot contain empty segments.`);
        }
        if (part.startsWith(':')) {
            const name = part.slice(1);
            if (name.length === 0 || /[:*%]/.test(name)) {
                throw new TypeError(
                    `Bun.serve: route "${key}" parameter names must be non-empty and cannot contain ":", "*", or "%".`,
                );
            }
            if (names.has(name)) {
                throw new TypeError(`Bun.serve: route "${key}" repeats the parameter ":${name}".`);
            }
            names.add(name);
            segments.push({ kind: 'param', name });
            continue;
        }
        if (part.includes(':') || part.includes('*')) {
            throw new TypeError(`Bun.serve: route "${key}" supports ":" parameters and "*" wildcards only as whole segments.`);
        }
        segments.push({ kind: 'static', value: part });
    }
    let staticCount = 0;
    for (const segment of segments) {
        if (segment.kind === 'static') staticCount++;
    }
    return { segments, wildcard, staticCount };
}

/**
 * Walk the pathname against the pattern without allocating: static segments
 * compare in place and param spans are recorded into reused scratch, so a
 * non-matching request leaves no garbage behind.
 */
function matchPattern(pathname: string, pattern: CompiledPattern): boolean {
    const { segments, spans } = pattern;
    let spanCount = 0;
    let position = 1; // pathname always starts with '/'
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]!;
        const separator = pathname.indexOf('/', position);
        const end = separator === -1 ? pathname.length : separator;
        if (end === position) return false;
        if (segment.kind === 'param') {
            spans[spanCount * 2] = position;
            spans[spanCount * 2 + 1] = end;
            spanCount++;
        } else if (!pathname.startsWith(segment.value, position) || position + segment.value.length !== end) {
            return false;
        }
        position = end;
        if (index < segments.length - 1) {
            if (position >= pathname.length || pathname.charCodeAt(position) !== 47 /* '/' */) return false;
            position++;
        }
    }
    if (pattern.wildcard) {
        // The pattern's "/*" contributes its own '/' separator, so '/files/*'
        // matches '/files/' and everything under it but not the bare '/files';
        // the catch-all '/*' has no preceding segments and matches every path.
        if (segments.length === 0) return true;
        return position < pathname.length && pathname.charCodeAt(position) === 47;
    }
    return position === pathname.length;
}

function decodeParamSegment(raw: string): string {
    if (!raw.includes('%')) return raw;
    try {
        return decodeURIComponent(raw);
    } catch {
        // Malformed escapes stay raw instead of failing the whole match.
        return raw;
    }
}

function capturedParams(pathname: string, pattern: CompiledPattern): Record<string, string> {
    const params: Record<string, string> = {};
    let spanIndex = 0;
    for (const segment of pattern.segments) {
        if (segment.kind !== 'param') continue;
        const start = pattern.spans[spanIndex * 2]!;
        const end = pattern.spans[spanIndex * 2 + 1]!;
        spanIndex++;
        // Own data property: a capture named `__proto__` must not ride the
        // inherited setter and vanish from the params object.
        Object.defineProperty(params, segment.name, {
            value: decodeParamSegment(pathname.slice(start, end)),
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }
    return params;
}

function selectMethodHandler(route: CompiledRoute, method: string): BunServeHandler | undefined {
    if (route instanceof Map) {
        return route.get(method) ?? (method === 'HEAD' ? route.get('GET') : undefined);
    }
    return route || undefined;
}

// More specific patterns win: Bun matches exact routes, then parameter routes,
// then wildcards, and among equals keeps registration order.
function patternOrder(left: CompiledPattern, right: CompiledPattern): number {
    return right.staticCount - left.staticCount || left.order - right.order;
}

export function compileRoutes(value: unknown): CompiledRoutes {
    if (!isRecord(value)) {
        throw new TypeError('Bun.serve: routes must be an object.');
    }
    const exact = new Map<string, ValidatedRoute>();
    const patterns: PendingPattern[] = [];
    let order = 0;
    for (const path of Reflect.ownKeys(value)) {
        if (typeof path !== 'string' || !path.startsWith('/') || /[?#]/.test(path)) {
            throw new TypeError('Bun.serve: route keys must be paths beginning with "/" — '
                + 'exact, `:param`, or trailing `*` — without queries or fragments.');
        }
        // Request URLs normalize dot segments and escape non-path characters.
        if (/%(?![0-9A-Fa-f]{2})/.test(path)
            || new URL(`http://route.invalid${path}`).pathname !== path) {
            throw new TypeError(`Bun.serve: route "${path}" must be a canonical, percent-encoded URL pathname.`);
        }
        const route: unknown = Reflect.get(value, path);
        const patternKey = path.includes(':') || path.includes('*');
        const parsed = patternKey ? parseRoutePattern(path) : undefined;
        let validatedRoute: ValidatedRoute;
        if (route === false) {
            validatedRoute = false;
        } else if (typeof route === 'function') {
            validatedRoute = route as BunServeHandler;
        } else if (route instanceof Response) {
            validatedRoute = validateTarget(route, path);
        } else {
            const descriptor = bunFileServeTargetOf(route);
            if (descriptor) {
                validatedRoute = { bunFile: descriptor };
            } else if (isRecord(route)) {
                let methodMap = Reflect.ownKeys(route).length > 0;
                for (const key of Reflect.ownKeys(route)) {
                    if (typeof key !== 'string' || !METHODS.has(key)) {
                        methodMap = false;
                        break;
                    }
                }
                if (methodMap) {
                    const methods = new Map<string, Target>();
                    for (const method of Reflect.ownKeys(route)) {
                        methods.set(method as string, validateTarget(Reflect.get(route, method), path));
                    }
                    validatedRoute = methods;
                } else {
                    const resolved = routeValueResolver?.(route, path);
                    if (resolved === undefined) {
                        throw new TypeError('Bun.serve: route values must be a function, Response, BunFile, '
                            + `method map, directory value, or false; "${path}" is none of these.`);
                    }
                    validatedRoute = resolved;
                }
            } else {
                throw new TypeError(`Bun.serve: route "${path}" must be a function, Response, BunFile, `
                    + 'method map, directory value, or false.');
            }
        }
        if (parsed) {
            if (patterns.length >= MAX_ROUTE_PATTERNS) {
                throw new RangeError('Bun.serve: more than 1024 parameter and wildcard routes; '
                    + 'use fewer dynamic patterns or a fetch handler.');
            }
            patterns.push({
                segments: parsed.segments,
                wildcard: parsed.wildcard,
                staticCount: parsed.staticCount,
                order: order++,
                route: validatedRoute,
                spans: [],
            });
        } else {
            exact.set(path, validatedRoute);
        }
    }

    // Validate and compile the whole table before cloning a body or installing any handler.
    const resources = new RouteResources();
    const compiledExact = new Map<string, CompiledRoute>();
    const paramPatterns: CompiledPattern[] = [];
    const wildcardPatterns: CompiledPattern[] = [];
    try {
        for (const [path, route] of exact) {
            compiledExact.set(path, compileValidatedRoute(route, resources.disposers));
        }
        for (const pattern of patterns) {
            const compiled: CompiledPattern = {
                segments: pattern.segments,
                wildcard: pattern.wildcard,
                staticCount: pattern.staticCount,
                order: pattern.order,
                spans: pattern.spans,
                route: compileValidatedRoute(pattern.route, resources.disposers),
            };
            (compiled.wildcard ? wildcardPatterns : paramPatterns).push(compiled);
        }
        paramPatterns.sort(patternOrder);
        wildcardPatterns.sort(patternOrder);
    } catch (error) {
        resources.dispose();
        throw error;
    }

    const compiled: CompiledRoutes = {
        dispose: () => resources.dispose(),
        resolve(request) {
            const pathname = new URL(request.url).pathname;
            const exactRoute = compiledExact.get(pathname);
            if (exactRoute !== undefined) {
                const handler = selectMethodHandler(exactRoute, request.method);
                // A disabled route falls through to fetch without consulting
                // lower-priority patterns, so "false" keeps disabling the path.
                return handler ? { handler, params: {} } : undefined;
            }
            for (const pattern of paramPatterns) {
                if (!matchPattern(pathname, pattern)) continue;
                const handler = selectMethodHandler(pattern.route, request.method);
                if (!handler) return undefined;
                return { handler, params: capturedParams(pathname, pattern) };
            }
            for (const pattern of wildcardPatterns) {
                if (!matchPattern(pathname, pattern)) continue;
                const handler = selectMethodHandler(pattern.route, request.method);
                if (!handler) return undefined;
                return { handler, params: capturedParams(pathname, pattern) };
            }
            return undefined;
        },
    };
    // The held resources never reference `compiled`, so the finalizer remains
    // a valid fallback when callers abandon a server without stopping it.
    routeFinalizer?.register(compiled, resources, resources.finalizerToken);
    return compiled;
}

function compileValidatedRoute(route: ValidatedRoute, disposers: Array<() => void>): CompiledRoute {
    if (route === false) return false;
    if (route instanceof Map) {
        const methods = new Map<string, BunServeHandler>();
        for (const [method, target] of route) {
            methods.set(method, compileTarget(target, disposers));
        }
        return methods;
    }
    if (typeof route === 'object' && 'bunFile' in route) {
        return compileBunFileTarget(route.bunFile, disposers);
    }
    return compileTarget(route, disposers);
}
