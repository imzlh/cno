import { join, relative, resolve, sep } from 'node:path';
import { nsfs } from '../node/fs/syspath';
import { utf8Decode } from '../utils/bytes';
import type { FileSystemRouterOptions } from 'bun';

const engine = import.meta.use('engine');
const nativeError = import.meta.use('error');

const fs = nsfs;
const requestUrl = Object.getOwnPropertyDescriptor(Request.prototype, 'url')!.get!;
const responseUrl = Object.getOwnPropertyDescriptor(Response.prototype, 'url')!.get!;
const defaultExtensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const missingLinkErrors = new Set<number>([
    nativeError.errno.ENOENT, nativeError.errno.ENOTDIR, nativeError.errno.ELOOP,
]);

export type { FileSystemRouterOptions };

export interface MatchedRoute {
    readonly params: Record<string, string>;
    readonly filePath: string;
    readonly pathname: string;
    readonly query: Record<string, string | string[]>;
    readonly name: string;
    readonly kind: 'exact' | 'dynamic' | 'catch-all' | 'optional-catch-all';
    readonly src: string;
    readonly scriptSrc: string;
}

interface Route {
    name: string;
    filePath: string;
    src: string;
    kind: MatchedRoute['kind'];
    rank: number;
    segments: string[];
    parameters: string[];
    pattern: RegExp;
}

interface RouteTable {
    routes: Record<string, string>;
    exact: Map<string, Route>;
    dynamic: Route[];
}

function optionString(name: string, value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string') {
        throw Object.assign(new TypeError(`FileSystemRouterOptions.${name} must be a string`), {
            code: 'ERR_INVALID_ARG_TYPE',
        });
    }
    return value || null;
}

function compileRoute(name: string, filePath: string, src: string): Route {
    const segments = name === '/' ? [] : name.slice(1).split('/');
    const parameters: string[] = [];
    let pattern = '^';
    let rank = 0;
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        const optional = /^\[\[\.\.\.([^\[\]]+)\]\]$/.exec(segment);
        const catchAll = /^\[\.\.\.([^\[\]]+)\]$/.exec(segment);
        const dynamic = /^\[([^\[\].]+)\]$/.exec(segment);
        const parameter = optional?.[1] ?? catchAll?.[1] ?? dynamic?.[1];
        if (parameter !== undefined) {
            if (parameters.includes(parameter) || ((optional || catchAll) && index !== segments.length - 1)) {
                throw Object.assign(new Error(`Invalid dynamic route "${name}"`), { name: 'BuildMessage' });
            }
            parameters.push(parameter);
            rank = Math.max(rank, optional ? 3 : catchAll ? 2 : 1);
            pattern += optional ? '(?:/(.*))?' : catchAll ? '/(.+)' : '/([^/]+)';
        } else {
            if (segment.includes('[') || segment.includes(']')) {
                throw Object.assign(new Error(`Invalid route segment "${segment}"`), { name: 'BuildMessage' });
            }
            pattern += '/' + segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
    }
    const kind = (['exact', 'dynamic', 'catch-all', 'optional-catch-all'] as const)[rank];
    return { name, filePath, src, kind, rank, segments, parameters, pattern: new RegExp(pattern + '$') };
}

function compareRoutes(left: Route, right: Route): number {
    if (left.rank !== right.rank) return left.rank - right.rank;
    for (let index = 0; index < Math.min(left.segments.length, right.segments.length); index++) {
        const leftDynamic = left.segments[index].startsWith('[');
        const rightDynamic = right.segments[index].startsWith('[');
        if (leftDynamic !== rightDynamic) return leftDynamic ? 1 : -1;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function inputPath(input: string | Request | Response): string {
    let source: string | undefined;
    if (typeof input === 'string') source = input;
    else {
        for (const getter of [requestUrl, responseUrl]) {
            try {
                source = Reflect.apply(getter, input, []) as string;
                break;
            } catch {
                // Captured getters check the host object's internal slots.
            }
        }
    }
    if (source === undefined) throw new TypeError('Expected string, Request or Response');
    const authority = /^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/?#]*/.exec(source);
    if (authority) {
        const fragment = source.indexOf('#', authority[0].length);
        source = source.slice(authority[0].length, fragment < 0 ? undefined : fragment);
        return source.startsWith('/') ? source : '/' + source;
    }
    return source || '/';
}

function decodeRouteComponent(value: string): string {
    if (!value.includes('%')) return value;
    if (/%(?![\da-f]{2})/i.test(value)) throw new URIError('Malformed percent escape');
    try {
        return decodeURIComponent(value);
    } catch {
        // Valid escapes can still contain malformed UTF-8, which Bun replaces.
        const bytes = engine.encodeString(value);
        let length = 0;
        for (let index = 0; index < bytes.length; index++) {
            if (bytes[index] === 0x25) {
                bytes[length++] = Number.parseInt(String.fromCharCode(bytes[index + 1], bytes[index + 2]), 16);
                index += 2;
            } else {
                bytes[length++] = bytes[index];
            }
        }
        return utf8Decode(bytes.subarray(0, length));
    }
}

export class FileSystemRouter {
    readonly #directory: string;
    readonly #extensions: ReadonlySet<string>;
    readonly #assetPrefix: string | null;
    readonly #origin: string | null;
    readonly #sourcePrefix: string;
    #table: RouteTable;

    constructor(options: FileSystemRouterOptions) {
        if (options === null || typeof options !== 'object') {
            throw Object.assign(new TypeError('Expected object'), { code: 'ERR_INVALID_ARG_TYPE' });
        }
        const directory = optionString('dir', options.dir);
        if (directory === null) {
            throw Object.assign(new TypeError('FileSystemRouterOptions.dir is required'), { code: 'ERR_INVALID_ARG_TYPE' });
        }
        const style = options.style;
        if (style !== 'nextjs') {
            throw Object.assign(new TypeError(style === undefined
                ? 'Expected \'style\' option (ex: "style": "nextjs")'
                : "Only 'nextjs' style is currently implemented"), { code: 'ERR_INVALID_ARG_TYPE' });
        }
        const extensions = options.fileExtensions;
        if (extensions !== undefined && (!Array.isArray(extensions) || extensions.some(value => typeof value !== 'string'))) {
            throw Object.assign(new TypeError('FileSystemRouterOptions.fileExtensions must be an array of string'), {
                code: 'ERR_INVALID_ARG_TYPE',
            });
        }
        this.#assetPrefix = optionString('assetPrefix', options.assetPrefix);
        this.#origin = optionString('origin', options.origin);
        let sourcePrefix = this.#assetPrefix ?? '';
        if (this.#origin) {
            try {
                sourcePrefix = new URL(sourcePrefix || '.', this.#origin).href;
            } catch {
                sourcePrefix = this.#origin.replace(/\/$/, '') + '/' + sourcePrefix;
            }
        }
        this.#sourcePrefix = sourcePrefix;
        this.#directory = fs.realpath(resolve(directory));
        this.#extensions = new Set(extensions?.length ? extensions : defaultExtensions);
        this.#table = this.#scan();
    }

    get style(): 'nextjs' {
        return 'nextjs';
    }

    get assetPrefix(): string | null {
        return this.#assetPrefix;
    }

    get origin(): string | null {
        return this.#origin;
    }

    get routes(): Record<string, string> {
        return this.#table.routes;
    }

    #scan(): RouteTable {
        const table: RouteTable = { routes: {}, exact: new Map(), dynamic: [] };
        const ancestors = new Set<string>();
        const visit = (directory: string, prefix: string): void => {
            const realDirectory = fs.realpath(directory);
            if (ancestors.has(realDirectory)) return;
            ancestors.add(realDirectory);
            try {
                const entries = fs.readdir(directory, true).sort((left, right) => left.name < right.name ? -1 : 1);
                for (const entry of entries) {
                    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                    const filePath = join(directory, entry.name);
                    let info: CModuleFS.DirEnt | CModuleFS.Stats = entry;
                    let resolvedPath = filePath;
                    if (entry.isSymbolicLink) {
                        try {
                            info = fs.stat(filePath);
                            resolvedPath = fs.realpath(filePath);
                        } catch (error) {
                            if (error !== null && typeof error === 'object'
                                && missingLinkErrors.has((error as { code: number }).code)) continue;
                            throw error;
                        }
                    }
                    if (info.isDirectory) {
                        visit(filePath, prefix + entry.name + '/');
                    } else if (info.isFile) {
                        const extensionAt = entry.name.lastIndexOf('.');
                        if (!this.#extensions.has(entry.name.slice(extensionAt))) continue;
                        const stem = entry.name.slice(0, extensionAt);
                        const name = '/' + prefix + (stem === 'index' ? '' : stem);
                        const routeName = name.length > 1 && name.endsWith('/') ? name.slice(0, -1) : name;
                        if (Object.hasOwn(table.routes, routeName)) {
                            throw Object.assign(new Error(`Route "${routeName}" is already defined by ${table.routes[routeName]}`), {
                                name: 'BuildMessage',
                            });
                        }
                        const src = this.#sourcePrefix + relative(this.#directory, filePath).split(sep).join('/');
                        const route = compileRoute(routeName, resolvedPath, src);
                        table.routes[routeName] = resolvedPath;
                        if (route.rank === 0) table.exact.set(routeName, route);
                        else table.dynamic.push(route);
                    }
                }
            } finally {
                ancestors.delete(realDirectory);
            }
        };
        visit(this.#directory, '');
        table.dynamic.sort(compareRoutes);
        return table;
    }

    match(input: string | Request | Response): MatchedRoute | null {
        const source = inputPath(input);
        const queryAt = source.lastIndexOf('?');
        let path: string;
        let search: string;
        try {
            path = decodeRouteComponent(queryAt < 0 ? source : source.slice(0, queryAt));
            search = queryAt < 0 ? '' : decodeRouteComponent(source.slice(queryAt + 1));
        } catch {
            throw new Error(`DecodingError parsing path: ${source}`);
        }
        if (!path.startsWith('/')) return null;
        const pathname = path + (queryAt < 0 ? '' : '?' + search);
        path = path.replace(/^\/+/, '/').replace(/\/+$/, '') || '/';
        if (path.endsWith('/index')) path = path.slice(0, -6) || '/';
        let route = this.#table.exact.get(path);
        let captures: RegExpExecArray | null = null;
        if (!route) {
            for (const candidate of this.#table.dynamic) {
                captures = candidate.pattern.exec(path);
                if (captures) {
                    route = candidate;
                    break;
                }
            }
        }
        if (!route) return null;
        const params: Record<string, string> = {};
        for (let index = 0; index < route.parameters.length; index++) {
            const value = captures![index + 1];
            if (value !== undefined && value !== '') {
                Object.defineProperty(params, route.parameters[index], {
                    value, enumerable: true, writable: true, configurable: true,
                });
            }
        }
        const query: Record<string, string | string[]> = { ...params };
        for (const field of search.split('&')) {
            const separator = field.indexOf('=');
            let key: string;
            let value: string;
            try {
                key = decodeRouteComponent(separator < 0 ? field : field.slice(0, separator));
                value = separator < 0 ? '' : decodeRouteComponent(field.slice(separator + 1));
            } catch {
                continue;
            }
            if (!key || Object.hasOwn(params, key)) continue;
            if (Object.hasOwn(query, key)) {
                const previous = query[key];
                if (Array.isArray(previous)) previous.push(value);
                else query[key] = [previous, value];
            } else {
                Object.defineProperty(query, key, { value, enumerable: true, writable: true, configurable: true });
            }
        }
        return {
            params, filePath: route.filePath, pathname, query, name: route.name, kind: route.kind,
            src: route.src, scriptSrc: route.src,
        };
    }

    reload(): this {
        this.#table = this.#scan();
        return this;
    }
}
