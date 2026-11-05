/**
 * Directory routes for Bun.serve: `routes: { '/assets/*': { dir: './assets' } }`.
 *
 * Serving a directory needs the host filesystem, so this module registers a
 * route-value resolver into serve-routes.ts instead of adding fs imports to
 * serve.ts (which pure-JS unit lanes bundle without runtime bindings).
 *
 * Bun semantics implemented here follow Serve.DirectoryRouteOptions: the
 * remainder after the route prefix is percent-decoded once, non-canonical
 * remainders (dot segments, empty segments, encoded separators) are rejected
 * with 404, directory requests without a trailing slash redirect (301), a
 * trailing slash serves the directory's index.html, and missing files 404.
 */

import { join } from '../utils/path';
import { realpath, stat as nodeStat } from '../node/fs/_promises';
import { file as newBunFile } from './file';
import { setServeRouteValueResolver } from './serve-routes';
import type { BunServeHandler } from './serve';
import type { ResolvedRouteValue } from './serve-routes';

const DIRECTORY_INDEX = 'index.html';

function notFound(): Response {
    return new Response(null, { status: 404 });
}

/**
 * Percent-decode the remainder once and reject every non-canonical shape.
 * The decoded segments are re-checked so encoded dots ("..") cannot survive
 * decoding, and encoded separators are rejected before decoding since they
 * would change which segments exist. Escapes of characters that can appear
 * literally in a path (unreserved ASCII) are rejected too: the router and
 * the exclusion table match on the raw remainder, so `/assets/%69ndex.html`
 * must not reach the same file as `/assets/index.html` through the back door.
 */
function canonicalRemainder(remainder: string): string | null {
    if (remainder.includes('%')) {
        if (/%(?:2f|5c)/i.test(remainder)) return null;
        if (/%(?![0-9A-Fa-f]{2})/.test(remainder)) return null;
        // Reject escapes of characters that can appear literally (unreserved
        // ASCII, RFC 3986): the router and exclusion table match the raw
        // remainder, so `%69ndex.html` must not alias `index.html`.
        for (const match of remainder.matchAll(/%([0-9A-Fa-f]{2})/g)) {
            const code = parseInt(match[1]!, 16);
            const unreserved = (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)
                || (code >= 0x30 && code <= 0x39) || code === 0x2D || code === 0x2E
                || code === 0x5F || code === 0x7E;
            if (unreserved) return null;
        }
        try {
            remainder = decodeURIComponent(remainder);
        } catch {
            // Malformed UTF-8 sequences are as non-canonical as malformed escapes.
            return null;
        }
    }
    if (remainder.includes('\\') || remainder.includes('\0')) return null;
    if (remainder === '') return remainder;
    // A double slash is an empty segment wherever it sits — including the
    // root-index form `//`, which must not alias the directory itself.
    if (remainder.includes('//')) return null;
    // A trailing slash selects the directory itself, so it is not an interior
    // empty segment; the index step consumes it.
    const body = remainder.endsWith('/') ? remainder.slice(0, -1) : remainder;
    if (body === '') return remainder;
    for (const part of body.split('/')) {
        if (part.length === 0 || part === '.' || part === '..') return null;
    }
    return remainder;
}

/** Realpath a path as a string; buffer encodings and failures yield undefined. */
async function realString(path: string): Promise<string | undefined> {
    try {
        const resolved = await realpath(path);
        return typeof resolved === 'string' ? resolved : undefined;
    } catch {
        return undefined;
    }
}

/** Realpath the request path and require it to stay inside the served root. */
async function resolveWithin(root: string, path: string): Promise<string | undefined> {
    const resolved = await realString(path);
    if (!resolved) return undefined;
    // Windows realpath returns backslash separators; normalize both sides so
    // containment compares the path, not the host's separator choice.
    const normalizedRoot = root.replaceAll('\\', '/');
    const normalizedResolved = resolved.replaceAll('\\', '/');
    const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    if (normalizedResolved !== normalizedRoot && !normalizedResolved.startsWith(prefix)) return undefined;
    return resolved;
}

/** Split a validator list on commas that sit outside quoted tags: an opaque
 *  ETag may itself contain commas and even a `*`, which must not read as the
 *  wildcard. */
function validatorList(headerValue: string): string[] {
    const out: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of headerValue) {
        if (ch === '"') inQuotes = !inQuotes;
        if (ch === ',' && !inQuotes) {
            if (current.trim() !== '') out.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim() !== '') out.push(current.trim());
    return out;
}

/** True when the request's conditional headers say the copy is still fresh.
 *  Only the two common validators are honored (ETag, then mtime); Range is
 *  outside this subset, so a matching conditional is a plain 304. */
function notModified(request: Request, etag: string, mtime: Date): boolean {
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch !== null) {
        // The client echoes the validator as sent (weak form) or as a strong
        // tag; either match — or a wildcard — means "send 304".
        const strong = `"${etag.slice(3, -1)}"`;
        return validatorList(ifNoneMatch).some(tag => tag === '*' || tag === etag || tag === strong);
    }
    const ifModifiedSince = request.headers.get('if-modified-since');
    if (ifModifiedSince !== null) {
        const since = Date.parse(ifModifiedSince);
        // HTTP dates have second granularity; floor (not truncate) so
        // pre-epoch fractional timestamps compare correctly.
        return Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) * 1000 <= since;
    }
    return false;
}

function fileResponse(request: Request, path: string, mtime: Date, size: number): Response {
    const target = newBunFile(path);
    const headers = new Headers();
    if (target.type) headers.set('content-type', target.type);
    headers.set('last-modified', mtime.toUTCString());
    // Weak ETag over the stat pair; range requests are outside this subset,
    // so the value drives the conditional GET below and manual inspection.
    const etag = `W/"${size.toString(16)}-${Math.trunc(mtime.getTime()).toString(16)}"`;
    headers.set('etag', etag);
    // Pin content-length like Bun's static serving so the host can skip
    // chunked framing — but only for sizes the stat can trust: procfs-style
    // files report size 0 while streaming real bytes, and a pinned 0 would
    // truncate them. Size 0 keeps EOF framing, which also serves empty files.
    if (size > 0) headers.set('content-length', String(size));
    if (notModified(request, etag, mtime)) {
        headers.delete('content-length');
        return new Response(null, { status: 304, headers });
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(target.stream(), { status: 200, headers });
}

function serveDirectory(prefix: string, dir: string): ResolvedRouteValue {
    const handler: BunServeHandler = async request => {
        const url = new URL(request.url);
        const pathname = url.pathname;
        if (!pathname.startsWith(prefix)) return notFound();
        const remainder = canonicalRemainder(pathname.slice(prefix.length));
        if (remainder === null) return notFound();

        let root: string | undefined;
        root = await realString(dir);
        if (!root) return notFound();
        const within = await resolveWithin(root, join(dir, remainder));
        if (!within) return notFound();
        const info = await nodeStat(within).catch(() => undefined);
        if (!info) return notFound();

        if (info.isDirectory()) {
            if (!pathname.endsWith('/')) {
                // Bun redirects directory requests to the trailing-slash URL.
                const location = `${pathname}/${url.search}`;
                return new Response(null, { status: 301, headers: { location } });
            }
            const indexWithin = await resolveWithin(root, join(within, DIRECTORY_INDEX));
            if (!indexWithin) return notFound();
            const indexInfo = await nodeStat(indexWithin).catch(() => undefined);
            if (!indexInfo || !indexInfo.isFile()) return notFound();
            return fileResponse(request, indexWithin, indexInfo.mtime, indexInfo.size);
        }
        if (!info.isFile()) return notFound();
        return fileResponse(request, within, info.mtime, info.size);
    };
    // GET and HEAD only; other methods fall through like an unmatched method map.
    return new Map<string, BunServeHandler>([['GET', handler], ['HEAD', handler]]);
}

function resolveDirectoryRoute(value: Record<PropertyKey, unknown>, path: string): ResolvedRouteValue | undefined {
    if (Reflect.get(value, 'dir') === undefined) return undefined;
    for (const key of Reflect.ownKeys(value)) {
        if (key !== 'dir' && key !== 'statCache') {
            throw new TypeError(`Bun.serve: directory route "${path}" supports only "dir" and "statCache" options.`);
        }
    }
    const dir = Reflect.get(value, 'dir');
    if (typeof dir !== 'string' || dir.length === 0) {
        throw new TypeError(`Bun.serve: directory route "${path}" requires a non-empty "dir" path.`);
    }
    const statCache = Reflect.get(value, 'statCache');
    if (statCache !== undefined && typeof statCache !== 'boolean') {
        throw new TypeError(`Bun.serve: directory route "${path}" statCache must be a boolean.`);
    }
    // Bun requires directory route keys to end in "/*"; the wildcard's prefix
    // delimits which part of the URL maps into the directory.
    if (!path.endsWith('/*')) {
        throw new TypeError(`Bun.serve: directory route "${path}" must end in "/*".`);
    }
    // A parameter segment in the prefix could never match a literal pathname,
    // so every request would silently 404; reject it loudly instead.
    if (path.slice(0, -2).includes(':')) {
        throw new TypeError(`Bun.serve: directory route "${path}" prefix must not contain parameter segments.`);
    }
    return serveDirectory(path.slice(0, -1), dir);
}

/** Install the directory-route resolver. Called once by the bun namespace. */
export function installServeStaticDirectoryRoutes(): void {
    setServeRouteValueResolver(resolveDirectoryRoute);
}
