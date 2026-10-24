import { bytesToArrayBuffer } from "../utils/bytes";
import { getMemoryTier } from "../utils/memory-tier";

const ILLEGAL = Symbol('cache.illegal');

/**
 * Responses are built with the platform constructors. Resolving them through
 * `globalThis` rather than importing `./fetch` keeps this module off the fetch
 * stack in the boot graph, and both are installed whenever a program can reach a
 * cache.
 */
function platformResponse(): typeof globalThis.Response {
    return globalThis.Response;
}

function maxEntries(): number {
    return getMemoryTier() === 'low' ? 64 : getMemoryTier() === 'normal' ? 256 : 1024;
}

function toRequestKey(input: RequestInfo | URL): Request {
    const RequestCtor = globalThis.Request;
    return input instanceof RequestCtor ? input : new RequestCtor(input);
}

function assertGetRequest(request: Request): void {
    if (request.method !== 'GET') {
        throw new TypeError('Cache only supports GET requests');
    }
}

function urlsMatch(storedUrl: string, candidateUrl: string, ignoreSearch?: boolean): boolean {
    if (!ignoreSearch) return storedUrl === candidateUrl;

    try {
        const stored = new URL(storedUrl);
        const candidate = new URL(candidateUrl);
        return stored.origin === candidate.origin
            && stored.pathname === candidate.pathname
            && stored.hash === candidate.hash;
    } catch {
        return storedUrl.split('?')[0] === candidateUrl.split('?')[0];
    }
}

function varyFields(headers: Headers): string[] {
    const vary = headers.get('Vary') ?? '';
    return vary.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function varyMatches(stored: Request, candidate: Request, responseHeaders: Headers): boolean {
    const fields = varyFields(responseHeaders);
    for (const field of fields) {
        if (stored.headers.get(field) !== candidate.headers.get(field)) return false;
    }
    return true;
}

interface CacheEntry {
    request: Request;
    response: globalThis.Response;
    responseHeaders: Headers;
    body: Uint8Array;
}

function queryMatches(entry: CacheEntry, request: Request, options?: CacheQueryOptions): boolean {
    if (!options?.ignoreMethod && request.method !== 'GET') return false;
    if (!urlsMatch(entry.request.url, request.url, options?.ignoreSearch)) return false;
    if (!options?.ignoreVary && !varyMatches(entry.request, request, entry.responseHeaders)) return false;
    return true;
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

    async put(request: RequestInfo | URL, response: globalThis.Response): Promise<void> {
        const req = toRequestKey(request);
        assertGetRequest(req);

        if ((response.headers.get('Vary') ?? '').split(',').map(s => s.trim()).includes('*')) {
            throw new TypeError("Vary header must not contain '*'");
        }

        let storedResponse: globalThis.Response = response;
        const body = await response.bytes();
        // A response built on a plain byte stream is bodyUsed after the read;
        // store a rebuilt one so the cached entry stays a usable, unconsumed Response.
        if (response.bodyUsed) {
            try {
                storedResponse = new (platformResponse())(bytesToArrayBuffer(body), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                }) as unknown as globalThis.Response;
            } catch {}
        }

        const responseHeaders = new Headers(response.headers);

        const idx = this.#entries.findIndex(e => queryMatches(e, req));
        const entry: CacheEntry = { request: req.clone(), response: storedResponse, responseHeaders, body };
        if (idx >= 0) {
            this.#entries[idx] = entry;
        } else {
            while (this.#entries.length >= maxEntries()) {
                this.#entries.shift();
            }
            this.#entries.push(entry);
        }
    }

    async match(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<globalThis.Response | undefined> {
        const req = toRequestKey(request);
        const entry = this.#entries.find(e => queryMatches(e, req, options));
        if (!entry) return undefined;
        return new (platformResponse())(bytesToArrayBuffer(entry.body), {
            status: entry.response.status,
            statusText: entry.response.statusText,
            headers: entry.responseHeaders,
        });
    }

    async matchAll(request?: RequestInfo | URL, options?: CacheQueryOptions): Promise<globalThis.Response[]> {
        if (request === undefined) return this.#entries.map(e =>
            new (platformResponse())(bytesToArrayBuffer(e.body), { status: e.response.status, headers: e.responseHeaders })
        );
        const req = toRequestKey(request);
        return this.#entries
            .filter(e => queryMatches(e, req, options))
            .map(e => new (platformResponse())(bytesToArrayBuffer(e.body), { status: e.response.status, headers: e.responseHeaders }));
    }

    async delete(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<boolean> {
        const req = toRequestKey(request);
        const before = this.#entries.length;
        this.#entries = this.#entries.filter(e => !queryMatches(e, req, options));
        return this.#entries.length < before;
    }

    async keys(request?: RequestInfo | URL, options?: CacheQueryOptions): Promise<ReadonlyArray<Request>> {
        if (request === undefined) return this.#entries.map(e => e.request.clone());
        const req = toRequestKey(request);
        return this.#entries.filter(e => queryMatches(e, req, options)).map(e => e.request.clone());
    }

    async add(request: RequestInfo | URL): Promise<void> {
        const req = toRequestKey(request);
        assertGetRequest(req);
        const response = await fetch(req.clone());
        if (!response.ok) {
            throw new TypeError(`Request failed with status ${response.status}`);
        }
        await this.put(req, response);
    }

    async addAll(requests: RequestInfo[]): Promise<void> {
        const reqs = Array.from(requests, toRequestKey);
        for (const req of reqs) assertGetRequest(req);
        const entries = await Promise.all(reqs.map(async (req) => {
            const response = await fetch(req.clone());
            if (!response.ok) {
                throw new TypeError(`Request failed with status ${response.status}`);
            }
            return { req, response };
        }));
        for (const { req, response } of entries) {
            await this.put(req, response);
        }
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

    async match(request: RequestInfo | URL, options?: MultiCacheQueryOptions): Promise<globalThis.Response | undefined> {
        if (options?.cacheName) {
            return await this.#caches.get(options.cacheName)?.match(request, options);
        }

        for (const cache of this.#caches.values()) {
            const res = await cache.match(request, options);
            if (res) return res;
        }
        return undefined;
    }

    get [Symbol.toStringTag]() {
        return 'CacheStorage';
    }
}

const CacheCtorProxy = new Proxy(function Cache() {
    throw new TypeError('Illegal constructor');
}, {
    construct() { throw new TypeError('Illegal constructor'); }
});

Reflect.set(globalThis, 'Cache', CacheCtorProxy);
Reflect.set(globalThis, 'CacheStorage', CacheStorageImpl);
// One instance per process, but only built (and only then reading the memory tier) on
// first use; the getter keeps identity stable and caches a live, never-reset store.
let cachesInstance: CacheStorageImpl | undefined;
Object.defineProperty(globalThis, 'caches', {
    get: () => cachesInstance ??= new CacheStorageImpl(),
    enumerable: true,
    configurable: true,
});
