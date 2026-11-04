import { join, normalize, resolve } from 'node:path';
import { nsasfs, nsfs } from '../../node/fs/syspath';
import type { GlobScanOptions } from 'bun';
import {
    assertGlobMatchValue,
    compileGlobPattern,
    expandBraces,
    hasGlobMagic,
    unescapeGlobLiteral,
    type CompiledGlobPattern,
} from './matcher';

const fs = nsfs;
const asyncfs = nsasfs;

export type { GlobScanOptions };

interface ResolvedScanOptions {
    cwd: string;
    dot: boolean;
    absolute: boolean;
    followSymlinks: boolean;
    throwErrorOnBrokenSymlink: boolean;
    onlyFiles: boolean;
}

interface ScanRoot {
    root: string;
    prefix: string;
    absolutePattern: boolean;
}

interface EntryInfo {
    fullPath: string;
    relativePath: string;
    directory: boolean;
    symbolicLink: boolean;
    brokenLink: boolean;
}

interface PatternPlan {
    matcher: CompiledGlobPattern;
    root: ScanRoot;
    maxDepth?: number;
}

function cwd(): string {
    const process = Reflect.get(globalThis, 'process');
    const getCwd = process && Reflect.get(process, 'cwd');
    if (typeof getCwd === 'function') return String(Reflect.apply(getCwd, process, []));
    return String(import.meta.use('os').cwd);
}

function scanOptions(value?: string | GlobScanOptions | null): ResolvedScanOptions {
    if (value === undefined || value === null) {
        return {
            cwd: resolve(cwd()),
            dot: false,
            absolute: false,
            followSymlinks: false,
            throwErrorOnBrokenSymlink: false,
            onlyFiles: true,
        };
    }
    if (typeof value === 'string') {
        return {
            cwd: resolve(value),
            dot: false,
            absolute: false,
            followSymlinks: false,
            throwErrorOnBrokenSymlink: false,
            onlyFiles: true,
        };
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw Object.assign(new TypeError('GlobScanOptions must be an object'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    if (value.cwd !== undefined && typeof value.cwd !== 'string') {
        throw Object.assign(new TypeError('cwd must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    return {
        cwd: resolve(value.cwd ?? cwd()),
        dot: !!value.dot,
        absolute: !!value.absolute,
        followSymlinks: !!value.followSymlinks,
        throwErrorOnBrokenSymlink: !!value.throwErrorOnBrokenSymlink,
        onlyFiles: value.onlyFiles === undefined ? true : !!value.onlyFiles,
    };
}

function normalizeGlobPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function isAbsoluteGlob(pattern: string): boolean {
    return pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern) || pattern.startsWith('//');
}

function staticPrefix(pattern: string): string {
    const segments = normalizeGlobPath(pattern).split('/');
    const prefix: string[] = [];
    for (const segment of segments) {
        if (hasGlobMagic(segment)) break;
        prefix.push(unescapeGlobLiteral(segment));
    }
    if (prefix.length === segments.length) prefix.pop();
    return prefix.join('/');
}

function scanRoot(pattern: string, options: ResolvedScanOptions): ScanRoot {
    const normalizedPattern = normalizeGlobPath(pattern);
    const absolutePattern = isAbsoluteGlob(normalizedPattern);
    let prefix = staticPrefix(normalizedPattern);
    if (normalizedPattern.startsWith('./') && prefix === '.') prefix = './';
    let root: string;
    if (absolutePattern) {
        if (prefix === '' && normalizedPattern.startsWith('/')) root = '/';
        else root = normalize(prefix || normalizedPattern);
    } else {
        root = resolve(options.cwd, prefix || '.');
    }
    return { root, prefix, absolutePattern };
}

function patternPlan(pattern: string, options: ResolvedScanOptions): PatternPlan {
    const root = scanRoot(pattern, options);
    const segments = pattern.split('/').filter(segment => segment !== '' && segment !== '.');
    const prefixSegments = root.prefix.split('/').filter(segment => segment !== '' && segment !== '.');
    return {
        matcher: compileGlobPattern(pattern),
        root,
        maxDepth: segments.includes('**') ? undefined : Math.max(1, segments.length - prefixSegments.length),
    };
}

function outputPath(entry: EntryInfo, options: ResolvedScanOptions, root: ScanRoot): string {
    if (root.absolutePattern || options.absolute) return normalizeGlobPath(resolve(entry.fullPath));
    return entry.relativePath;
}

function candidatePath(entry: EntryInfo, root: ScanRoot): string {
    if (root.absolutePattern) return normalizeGlobPath(resolve(entry.fullPath));
    return entry.relativePath;
}

function entryFromSync(
    fullPath: string,
    relativePath: string,
    stat: CModuleFS.DirEnt | CModuleFS.Stats,
    throwOnBrokenSymlink: boolean,
): EntryInfo {
    const symbolicLink = stat.isSymbolicLink;
    let directory = stat.isDirectory;
    let brokenLink = false;
    if (symbolicLink) {
        try {
            directory = fs.stat(fullPath).isDirectory;
        } catch (error) {
            if (throwOnBrokenSymlink) throw error;
            brokenLink = true;
        }
    }
    return { fullPath, relativePath, directory, symbolicLink, brokenLink };
}

async function entryFromAsync(
    fullPath: string,
    relativePath: string,
    stat: CModuleAsyncFS.DirEnt | CModuleAsyncFS.StatResult,
    throwOnBrokenSymlink: boolean,
): Promise<EntryInfo> {
    const symbolicLink = stat.isSymbolicLink;
    let directory = stat.isDirectory;
    let brokenLink = false;
    if (symbolicLink) {
        try {
            directory = (await asyncfs.stat(fullPath)).isDirectory;
        } catch (error) {
            if (throwOnBrokenSymlink) throw error;
            brokenLink = true;
        }
    }
    return { fullPath, relativePath, directory, symbolicLink, brokenLink };
}

function entryMatches(entry: EntryInfo, plan: PatternPlan, options: ResolvedScanOptions): boolean {
    if (entry.brokenLink && options.onlyFiles) return false;
    if (options.onlyFiles && entry.directory) return false;
    if (plan.matcher.negated && !options.dot && !plan.matcher.requiresExplicitDot
        && entry.relativePath.split('/').some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..')) return false;
    return plan.matcher.match(candidatePath(entry, plan.root), options.dot);
}

function validateCwdSync(path: string): void {
    const stat = fs.stat(path);
    if (!stat.isDirectory) {
        const error = Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), {
            code: 'ENOTDIR',
            syscall: 'open',
            path,
        });
        throw error;
    }
}

async function validateCwd(path: string): Promise<void> {
    const stat = await asyncfs.stat(path);
    if (!stat.isDirectory) {
        const error = Object.assign(new Error(`ENOTDIR: not a directory, open '${path}'`), {
            code: 'ENOTDIR',
            syscall: 'open',
            path,
        });
        throw error;
    }
}

function parentRelative(prefix: string, name: string): string {
    if (!prefix || prefix === '.') return name;
    return `${normalizeGlobPath(prefix).replace(/\/$/, '')}/${name}`;
}

function initialRelative(root: ScanRoot): string {
    if (root.absolutePattern) return normalizeGlobPath(root.root);
    if (root.prefix === './') return './';
    return normalizeGlobPath(root.prefix).replace(/\/$/, '');
}

function shouldTraverse(entry: EntryInfo, options: ResolvedScanOptions): boolean {
    if (!entry.directory || entry.brokenLink) return false;
    return !entry.symbolicLink || options.followSymlinks;
}

function directoryIdentitySync(entry: EntryInfo): string | null {
    try {
        return normalizeGlobPath(fs.realpath(entry.fullPath));
    } catch {
        return null;
    }
}

async function directoryIdentity(entry: EntryInfo): Promise<string | null> {
    try {
        return normalizeGlobPath(await asyncfs.realPath(entry.fullPath));
    } catch {
        return null;
    }
}

function sortEntries<T extends { name: string }>(entries: T[]): T[] {
    // Bun's traversal is stable but intentionally not promised to be lexical.
    // Sorting gives cno deterministic results across native filesystem drivers.
    return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function* scanPlanSync(plan: PatternPlan, options: ResolvedScanOptions): Generator<string> {
    let rootStat: CModuleFS.Stats;
    try {
        rootStat = fs.lstat(plan.root.root);
    } catch (error) {
        if (plan.root.absolutePattern) throw error;
        return;
    }

    const rootRelative = initialRelative(plan.root);
    const rootEntry = entryFromSync(plan.root.root, rootRelative, rootStat, options.throwErrorOnBrokenSymlink);
    if (rootRelative && entryMatches(rootEntry, plan, options)) yield outputPath(rootEntry, options, plan.root);
    if (!rootEntry.directory) return;

    const queue: Array<{ entry: EntryInfo; ancestors: ReadonlySet<string>; depth: number }> = [{ entry: rootEntry, ancestors: new Set(), depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift()!;
        let ancestors = current.ancestors;
        if (options.followSymlinks) {
            const identity = directoryIdentitySync(current.entry);
            if (!identity || ancestors.has(identity)) continue;
            ancestors = new Set(ancestors);
            (ancestors as Set<string>).add(identity);
        }

        let children: CModuleFS.DirEnt[];
        try {
            children = sortEntries(fs.readdir(current.entry.fullPath, true));
        } catch {
            continue;
        }
        for (const child of children) {
            const relativePath = parentRelative(current.entry.relativePath, child.name);
            const entry = entryFromSync(join(current.entry.fullPath, child.name), relativePath, child, options.throwErrorOnBrokenSymlink);
            if (entryMatches(entry, plan, options)) yield outputPath(entry, options, plan.root);
            if (shouldTraverse(entry, options) && (plan.maxDepth === undefined || current.depth + 1 < plan.maxDepth)) {
                queue.push({ entry, ancestors, depth: current.depth + 1 });
            }
        }
    }
}

async function* scanPlan(plan: PatternPlan, options: ResolvedScanOptions): AsyncGenerator<string> {
    let rootStat: CModuleAsyncFS.StatResult;
    try {
        rootStat = await asyncfs.lstat(plan.root.root);
    } catch (error) {
        if (plan.root.absolutePattern) throw error;
        return;
    }

    const rootRelative = initialRelative(plan.root);
    const rootEntry = await entryFromAsync(plan.root.root, rootRelative, rootStat, options.throwErrorOnBrokenSymlink);
    if (rootRelative && entryMatches(rootEntry, plan, options)) yield outputPath(rootEntry, options, plan.root);
    if (!rootEntry.directory) return;

    const queue: Array<{ entry: EntryInfo; ancestors: ReadonlySet<string>; depth: number }> = [{ entry: rootEntry, ancestors: new Set(), depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift()!;
        let ancestors = current.ancestors;
        if (options.followSymlinks) {
            const identity = await directoryIdentity(current.entry);
            if (!identity || ancestors.has(identity)) continue;
            ancestors = new Set(ancestors);
            (ancestors as Set<string>).add(identity);
        }

        let directory: CModuleAsyncFS.DirHandle;
        try {
            directory = await asyncfs.readDir(current.entry.fullPath);
        } catch {
            continue;
        }
        const children: CModuleAsyncFS.DirEnt[] = [];
        try {
            for await (const child of directory) children.push(child);
        } finally {
            await directory.close();
        }
        for (const child of sortEntries(children)) {
            const relativePath = parentRelative(current.entry.relativePath, child.name);
            const entry = await entryFromAsync(join(current.entry.fullPath, child.name), relativePath, child, options.throwErrorOnBrokenSymlink);
            if (entryMatches(entry, plan, options)) yield outputPath(entry, options, plan.root);
            if (shouldTraverse(entry, options) && (plan.maxDepth === undefined || current.depth + 1 < plan.maxDepth)) {
                queue.push({ entry, ancestors, depth: current.depth + 1 });
            }
        }
    }
}

function plansFor(compiled: CompiledGlobPattern, options: ResolvedScanOptions): PatternPlan[] {
    if (compiled.negated) {
        return compiled.expanded.map(pattern => {
            // A negated pattern can match siblings of its literal prefix, but
            // without a globstar it still only scans the pattern's depth.
            const segments = pattern.split('/').filter(segment => segment !== '' && segment !== '.');
            const rootPattern = isAbsoluteGlob(pattern) ? '/*' : pattern.startsWith('./') ? './*' : '*';
            return {
                matcher: compiled,
                root: scanRoot(rootPattern, options),
                maxDepth: segments.includes('**') ? undefined : Math.max(1, segments.length),
            };
        });
    }
    return expandBraces(compiled.source).map(pattern => patternPlan(pattern, options));
}

export class Glob {
    readonly #compiled: CompiledGlobPattern;

    constructor(pattern: string) {
        this.#compiled = compileGlobPattern(pattern);
    }

    match(value: string): boolean {
        assertGlobMatchValue(value);
        // Bun.Glob#match is purely lexical and includes dot-prefixed segments.
        return this.#compiled.match(value, true);
    }

    *scanSync(optionsOrCwd?: string | GlobScanOptions): IterableIterator<string> {
        const options = scanOptions(optionsOrCwd);
        validateCwdSync(options.cwd);
        const seen = new Set<string>();
        for (const plan of plansFor(this.#compiled, options)) {
            for (const path of scanPlanSync(plan, options)) {
                if (seen.has(path)) continue;
                seen.add(path);
                yield path;
            }
        }
    }

    async *scan(optionsOrCwd?: string | GlobScanOptions): AsyncIterableIterator<string> {
        const options = scanOptions(optionsOrCwd);
        await validateCwd(options.cwd);
        const seen = new Set<string>();
        for (const plan of plansFor(this.#compiled, options)) {
            for await (const path of scanPlan(plan, options)) {
                if (seen.has(path)) continue;
                seen.add(path);
                yield path;
            }
        }
    }
}

export default Glob;
