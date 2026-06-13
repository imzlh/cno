// CacheStorage + Cache — in-memory implementation for cno runtime.
// Matches the subset of the Cache API tested by Deno's cache_api_test.ts.

import { Response } from "./fetch";

declare const globalThis: any;

const ILLEGAL = Symbol('cache.illegal');

function toRequestKey(input: string | URL | Request): Request {
    if (typeof input === 'string') return new globalThis.Request(input);
    if (input instanceof URL) return new globalThis.Request(input.href);
    return input as Request;
}

// Parse Vary header and return the list of field names (lower-cased).
function varyFields(headers: Headers): string[] {
    const vary = headers.get('Vary') ?? '';
    return vary.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Check whether two requests match under the response's Vary constraints.
function varyMatches(stored: Request, candidate: Request, responseHeaders: Headers): boolean {
    const fields = varyFields(responseHeaders);
    for (const field of fields) {
        if (stored.headers.get(field) !== candidate.headers.get(field)) return false;
    }
    return true;
}

interface CacheEntry {
    request: Request;
    response: Response;
    responseHeaders: Headers;
    body: Uint8Array;
}

class CacheImpl implements Cache {
    static #allowConstruct = false;
    #entries: CacheEntry[] = [];

    constructor() {
        if (!CacheImpl.#allowConstruct) {
            throw new TypeError('Illegal constructor');
        }
    }

    static _create(): CacheImpl {
        CacheImpl.#allowConstruct = true;
        const c = new CacheImpl();
        CacheImpl.#allowConstruct = false;
        return c;
    }

    async put(request: RequestInfo | URL, response: Response): Promise<void> {
        const req = toRequestKey(request as string | URL | Request);

        // Vary: * is forbidden
        if ((response.headers.get('Vary') ?? '').split(',').map(s => s.trim()).includes('*')) {
            throw new TypeError("Vary header must not contain '*'");
        }

        // Consume the body — throws if stream errors, leaves bodyUsed = true
        if (response.bodyUsed) throw new TypeError('Body already consumed');
        let body: Uint8Array;
        try {
            body = await (response as any).bytes();
        } catch (e) {
            // Body read failed — do not store, re-throw
            throw e;
        }

        const responseHeaders = new (globalThis.Headers as typeof Headers)(response.headers);

        // Overwrite existing entry with same URL (ignoring Vary for overwrite lookup)
        const idx = this.#entries.findIndex(e => e.request.url === req.url && varyMatches(e.request, req, e.responseHeaders));
        const entry: CacheEntry = { request: req, response, responseHeaders, body };
        if (idx >= 0) {
            this.#entries[idx] = entry;
        } else {
            this.#entries.push(entry);
        }
    }

    async match(request: RequestInfo | URL, _options?: CacheQueryOptions): Promise<Response | undefined> {
        const req = toRequestKey(request as string | URL | Request);
        const entry = this.#entries.find(e => e.request.url === req.url && varyMatches(e.request, req, e.responseHeaders));
        if (!entry) return undefined;
        // Return a fresh Response backed by the stored bytes
        return new Response(entry.body.buffer.slice(entry.body.byteOffset, entry.body.byteOffset + entry.body.byteLength), {
            status: entry.response.status,
            statusText: entry.response.statusText,
            headers: entry.responseHeaders,
        });
    }

    async matchAll(request?: RequestInfo | URL, _options?: CacheQueryOptions): Promise<Response[]> {
        if (request === undefined) return this.#entries.map(e =>
            new (globalThis.Response as typeof Response)(e.body, { status: e.response.status, headers: e.responseHeaders })
        );
        const req = toRequestKey(request as string | URL | Request);
        return this.#entries
            .filter(e => e.request.url === req.url && varyMatches(e.request, req, e.responseHeaders))
            .map(e => new (globalThis.Response as typeof Response)(e.body, { status: e.response.status, headers: e.responseHeaders }));
    }

    async delete(request: RequestInfo | URL, _options?: CacheQueryOptions): Promise<boolean> {
        const req = toRequestKey(request as string | URL | Request);
        const before = this.#entries.length;
        this.#entries = this.#entries.filter(e => !(e.request.url === req.url && varyMatches(e.request, req, e.responseHeaders)));
        return this.#entries.length < before;
    }

    async keys(request?: RequestInfo | URL, _options?: CacheQueryOptions): Promise<ReadonlyArray<Request>> {
        if (request === undefined) return this.#entries.map(e => e.request);
        const req = toRequestKey(request as string | URL | Request);
        return this.#entries.filter(e => e.request.url === req.url).map(e => e.request);
    }

    async add(_request: RequestInfo | URL): Promise<void> {
        throw new Error('Cache.add() not supported');
    }

    async addAll(_requests: RequestInfo[]): Promise<void> {
        throw new Error('Cache.addAll() not supported');
    }
    
    get [Symbol.toStringTag]() {
        return 'Cache';
    }
}

class CacheStorageImpl implements CacheStorage {
    #caches = new Map<string, CacheImpl>();

    async open(cacheName: string): Promise<Cache> {
        let cache = this.#caches.get(cacheName);
        if (!cache) {
            cache = CacheImpl._create();
            this.#caches.set(cacheName, cache);
        }
        return cache;
    }

    async has(cacheName: string): Promise<boolean> {
        return this.#caches.has(cacheName);
    }

    async delete(cacheName: string): Promise<boolean> {
        return this.#caches.delete(cacheName);
    }

    async keys(): Promise<string[]> {
        return [...this.#caches.keys()];
    }

    async match(_request: RequestInfo | URL, _options?: MultiCacheQueryOptions): Promise<Response | undefined> {
        for (const cache of this.#caches.values()) {
            const res = await cache.match(_request as any);
            if (res) return res;
        }
        return undefined;
    }

    get [Symbol.toStringTag]() {
        return 'CacheStorage';
    }
}

// Expose Cache constructor that always throws (per spec, Cache is not directly constructable)
const CacheCtorProxy = new Proxy(function Cache() {
    throw new TypeError('Illegal constructor');
}, {
    construct() { throw new TypeError('Illegal constructor'); }
});

Reflect.set(globalThis, 'Cache', CacheCtorProxy);
Reflect.set(globalThis, 'CacheStorage', CacheStorageImpl);
Reflect.set(globalThis, 'caches', new CacheStorageImpl());
