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

import { isPathWithin, join } from '../utils/path';
import { realpath, stat as nodeStat } from '../node/fs/_promises';
import { file as newBunFile } from './file';
import { openValidatedReadableFile, type OpenedReadableFile } from './opened-file';
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
        // Reject escapes of characters that can appear literally in a path
        // segment: the router and exclusion table match the raw remainder, so
        // `%69ndex.html` and `secret%40.txt` must not alias exact routes.
        for (const match of remainder.matchAll(/%([0-9A-Fa-f]{2})/g)) {
            const code = parseInt(match[1]!, 16);
            const unreserved = (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)
                || (code >= 0x30 && code <= 0x39) || code === 0x2D || code === 0x2E
                || code === 0x5F || code === 0x7E;
            const literalPunctuation = code === 0x21 || code === 0x24 || code === 0x26
                || (code >= 0x27 && code <= 0x2C) || code === 0x3A || code === 0x3B
                || code === 0x3D || code === 0x40;
            if (unreserved || literalPunctuation) return null;
        }
        try {
            remainder = decodeURIComponent(remainder);
        } catch {
            // Malformed UTF-8 sequences are as non-canonical as malformed escapes.
            return null;
        }
    }
    if (remainder.includes('\\') || remainder.includes('\0') || remainder.startsWith('/')) return null;
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
    // The shared helper is separator- and case-aware without treating a
    // backslash in a POSIX filename as a directory boundary.
    if (!isPathWithin(root, resolved)) return undefined;
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
        // tag. Bun accepts '*' only when it is the whole field value.
        const strong = `"${etag.slice(3, -1)}"`;
        const trimmed = ifNoneMatch.trim();
        return trimmed === '*' || validatorList(ifNoneMatch).some(tag => tag === etag || tag === strong);
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

/** Parse a single-range `Range` header. Returns the inclusive byte window, or
 *  `'ignore'` for absent/multi-range/non-byte/invalid syntax (serve the whole
 *  file), or `'unsatisfiable'` for a well-formed range past the end (416). */
function parseRange(header: string, size: number): { start: number; end: number } | 'ignore' | 'unsatisfiable' {
    const match = /^bytes=(.*)$/i.exec(header.trim());
    if (!match) return 'ignore';
    // Only single ranges are served; a list (even a valid one) falls back to
    // the full body, matching the conservative static-serving subset.
    const spec = match[1]!;
    if (spec.includes(',')) return 'ignore';
    const dash = spec.indexOf('-');
    if (dash < 0) return 'ignore';
    const startText = spec.slice(0, dash);
    const endText = spec.slice(dash + 1);
    if (startText === '') {
        // Suffix form: the final N bytes; more bytes than the file has yields
        // the whole file.
        if (!/^\d+$/.test(endText)) return 'ignore';
        const suffix = Number(endText);
        if (!Number.isSafeInteger(suffix)) return 'ignore';
        if (suffix === 0) return 'unsatisfiable';
        // Bun ignores a non-zero suffix range for an empty representation,
        // while the explicit zero suffix remains a 416 above.
        if (size === 0) return 'ignore';
        const start = Math.max(0, size - suffix);
        return { start, end: size - 1 };
    }
    if (!/^\d+$/.test(startText)) return 'ignore';
    const start = Number(startText);
    if (!Number.isSafeInteger(start)) return 'ignore';
    if (endText === '') return start >= size ? 'unsatisfiable' : { start, end: size - 1 };
    if (!/^\d+$/.test(endText)) return 'ignore';
    const requestedEnd = Number(endText);
    if (!Number.isSafeInteger(requestedEnd)) return 'ignore';
    if (start >= size) return 'unsatisfiable';
    const end = Math.min(requestedEnd, size - 1);
    if (end < start) return 'ignore';
    return { start, end };
}

/** If-Range only enables ranges for a matching strong tag or fresh date. Our
 *  generated ETag is weak, so only the date form can currently match. */
function ifRangeMatches(request: Request, mtime: Date): boolean {
    const value = request.headers.get('if-range');
    if (value === null) return true;
    const trimmed = value.trim();
    if (trimmed.startsWith('"') || /^W\//i.test(trimmed)) return false;
    // Bun accepts the two HTTP date forms below; Date.parse's ISO extensions
    // are too broad for If-Range.
    const imfFixdate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
    const rfc850 = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
    if (!imfFixdate.test(trimmed) && !rfc850.test(trimmed)) {
        return false;
    }
    const since = Date.parse(trimmed);
    return Number.isFinite(since) && Math.floor(mtime.getTime() / 1000) * 1000 === since;
}

async function fileResponse(request: Request, path: string, target: OpenedReadableFile): Promise<Response> {
    try {
        const mtime = target.stat.mtim;
        const size = target.stat.size;
        const headers = new Headers();
        const contentType = newBunFile(path).type;
        if (contentType) headers.set('content-type', contentType);
        headers.set('last-modified', mtime.toUTCString());

        // A pseudo-file may advertise a positive but fictional st_size. In that
        // case total-size validators and ranges would be wrong, so serve to EOF.
        if (!target.sizeKnown) {
            if (request.method === 'HEAD') {
                await target.close();
                return new Response(null, { status: 200, headers });
            }
            return new Response(target.stream(), { status: 200, headers });
        }

        // Weak ETag over the stat pair; the value drives the conditional GET below
        // and manual inspection.
        const etag = `W/"${size.toString(16)}-${Math.trunc(mtime.getTime()).toString(16)}"`;
        headers.set('etag', etag);
        headers.set('content-length', String(size));
        if (notModified(request, etag, mtime)) {
            headers.delete('content-length');
            await target.close();
            return new Response(null, { status: 304, headers });
        }
        const rangeHeader = request.headers.get('range');
        if (rangeHeader !== null && ifRangeMatches(request, mtime)) {
            const range = parseRange(rangeHeader, size);
            if (range === 'unsatisfiable') {
                const failHeaders = new Headers({ 'content-range': `bytes */${size}` });
                await target.close();
                return new Response(null, { status: 416, headers: failHeaders });
            }
            if (range !== 'ignore') {
                const { start, end } = range;
                const rangeHeaders = new Headers(headers);
                rangeHeaders.set('content-range', `bytes ${start}-${end}/${size}`);
                const length = end - start + 1;
                rangeHeaders.set('content-length', String(length));
                if (request.method === 'HEAD') {
                    await target.close();
                    return new Response(null, { status: 206, headers: rangeHeaders });
                }
                return new Response(target.stream(start, end + 1), { status: 206, headers: rangeHeaders });
            }
        }
        if (request.method === 'HEAD') {
            await target.close();
            return new Response(null, { status: 200, headers });
        }
        return new Response(target.stream(), { status: 200, headers });
    } catch (error) {
        await target.close();
        throw error;
    }
}

function serveDirectory(prefix: string, dir: string): ResolvedRouteValue {
    const rootPromise = realString(dir);
    const handler: BunServeHandler = async request => {
        const url = new URL(request.url);
        const pathname = url.pathname;
        if (!pathname.startsWith(prefix)) return notFound();
        const remainder = canonicalRemainder(pathname.slice(prefix.length));
        if (remainder === null) return notFound();

        const root = await rootPromise;
        if (!root) return notFound();
        // Build candidates from the canonical root captured when the route was
        // registered; replacing a root path or symlink must not retarget an
        // already-running server to a different directory.
        const within = await resolveWithin(root, join(root, remainder));
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
            const indexTarget = await openValidatedReadableFile(root, indexWithin);
            if (!indexTarget) return notFound();
            return fileResponse(request, indexWithin, indexTarget);
        }
        if (!info.isFile()) return notFound();
        const target = await openValidatedReadableFile(root, within);
        if (!target) return notFound();
        return fileResponse(request, within, target);
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
