import { join, normalize, resolve } from 'node:path';
import { nsasfs, nsfs } from '../../node/fs/syspath';
import type { GlobScanOptions } from 'bun';
import {
    compileGlobPattern,
    expandBraces,
    globMatchValue,
    globStringValue,
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
    candidateMatcher?: CompiledGlobPattern;
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
    const directCwd = globStringValue(value);
    if (directCwd !== null) {
        return {
            cwd: resolve(directCwd),
            dot: false,
            absolute: false,
            followSymlinks: false,
            throwErrorOnBrokenSymlink: false,
            onlyFiles: true,
        };
    }
    if (typeof value !== 'object' && typeof value !== 'function') {
        throw Object.assign(new TypeError('GlobScanOptions must be an object'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    // Bun observes option getters in this order before starting traversal.
    const onlyFiles = value.onlyFiles;
    const throwErrorOnBrokenSymlink = value.throwErrorOnBrokenSymlink;
    const followSymlinks = value.followSymlinks;
    const absolute = value.absolute;
    const cwdValue = value.cwd;
    const dot = value.dot;
    const cwdString = cwdValue == null ? null : globStringValue(cwdValue);
    if (cwdValue != null && cwdString === null) {
        throw Object.assign(new TypeError('GlobScanOptions.cwd must be a string'), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    return {
        cwd: resolve(cwdString ?? cwd()),
        dot: !!dot,
        absolute: !!absolute,
        followSymlinks: !!followSymlinks,
        throwErrorOnBrokenSymlink: !!throwErrorOnBrokenSymlink,
        onlyFiles: onlyFiles == null ? true : !!onlyFiles,
    };
}

function normalizeGlobPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function normalizeGlobPattern(value: string): string {
    let output = '';
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== '\\') {
            output += value[index];
            continue;
        }
        if (value[index + 1] === '\\') {
            output += '/';
            index++;
        } else if (index + 1 < value.length) {
            // Keep glob escapes intact so they cannot become path separators.
            output += value[index] + value[++index];
        } else {
            output += '/';
        }
    }
    return output.replace(/\/+/g, '/');
}

function isAbsoluteGlob(pattern: string): boolean {
    return pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern) || pattern.startsWith('//');
}

function staticPrefix(pattern: string): string {
    const segments = normalizeGlobPattern(pattern).split('/');
    const prefix: string[] = [];
    for (const segment of segments) {
        if (hasGlobMagic(segment)) break;
        prefix.push(unescapeGlobLiteral(segment));
    }
    if (prefix.length === segments.length) prefix.pop();
    return prefix.join('/');
}

function scanRoot(pattern: string, options: ResolvedScanOptions): ScanRoot {
    const normalizedPattern = normalizeGlobPattern(pattern);
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

function negatedCandidatePattern(pattern: string): string {
    const segments = normalizeGlobPattern(pattern).split('/');
    let index = 0;
    while (segments[index] === '' || segments[index] === '.') index++;
    if (index === 0 && /^[A-Za-z]:$/.test(segments[index] ?? '')) index++;
    if (index < segments.length) segments[index] = '*';
    return segments.join('/');
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
    const candidate = candidatePath(entry, plan.root);
    if (plan.candidateMatcher && !plan.candidateMatcher.match(candidate, options.dot)) return false;
    if (plan.matcher.negated && !options.dot && !plan.matcher.requiresExplicitDot
        && entry.relativePath.split('/').some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..')) return false;
    return plan.matcher.match(candidate, options.dot);
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
                // Bun keeps the suffix as the scan shape: !sub/*.ts visits
                // sibling directories, but still only emits their *.ts files.
                candidateMatcher: compileGlobPattern(negatedCandidatePattern(pattern)),
                root: scanRoot(rootPattern, options),
                maxDepth: segments.includes('**') ? undefined : Math.max(1, segments.length),
            };
        });
    }
    return expandBraces(compiled.source).map(pattern => patternPlan(pattern, options));
}

function invalidGlobThis(value: unknown): TypeError & { code: string } {
    let received = '';
    if (value === null) {
        received = ', but received null';
    } else if (value !== undefined) {
        const type = typeof value;
        if (type === 'object') {
            const constructor = Reflect.get(value as object, 'constructor');
            const name = constructor == null ? 'Object' : Reflect.get(Object(constructor), 'name');
            received = `, but received an instance of ${String(name ?? 'Object')}`;
        } else if (type === 'function') {
            received = `, but received function ${(value as Function).name}`;
        } else {
            received = `, but received type ${type}`;
        }
    }
    return Object.assign(new TypeError(`Expected this to be instanceof Glob${received}`), { code: 'ERR_INVALID_THIS' });
}

export class Glob {
    readonly #compiled: CompiledGlobPattern;

    constructor(pattern: string) {
        this.#compiled = compileGlobPattern(pattern);
    }

    match(value: string): boolean {
        let compiled: CompiledGlobPattern;
        try {
            compiled = this.#compiled;
        } catch {
            throw invalidGlobThis(this);
        }
        // Bun.Glob#match is purely lexical and includes dot-prefixed segments.
        return compiled.match(globMatchValue(value), true);
    }

    scanSync(optionsOrCwd?: string | GlobScanOptions): IterableIterator<string> {
        const compiled = this.#compiled;
        const options = scanOptions(optionsOrCwd);
        validateCwdSync(options.cwd);
        return (function* (): Generator<string> {
            const seen = new Set<string>();
            for (const plan of plansFor(compiled, options)) {
                for (const path of scanPlanSync(plan, options)) {
                    if (seen.has(path)) continue;
                    seen.add(path);
                    yield path;
                }
            }
        })();
    }

    scan(optionsOrCwd?: string | GlobScanOptions): AsyncIterableIterator<string> {
        const compiled = this.#compiled;
        const options = scanOptions(optionsOrCwd);
        return (async function* (): AsyncGenerator<string> {
            await validateCwd(options.cwd);
            const seen = new Set<string>();
            for (const plan of plansFor(compiled, options)) {
                for await (const path of scanPlan(plan, options)) {
                    if (seen.has(path)) continue;
                    seen.add(path);
                    yield path;
                }
            }
        })();
    }
}

Object.defineProperty(Glob.prototype, 'match', { enumerable: true, configurable: false });
for (const method of [Glob.prototype.scan, Glob.prototype.scanSync]) {
    Object.defineProperty(method, 'name', { value: '' });
}
Object.defineProperty(Glob.prototype, 'scan', { enumerable: true });
Object.defineProperty(Glob.prototype, 'scanSync', { enumerable: true });
Object.defineProperty(Glob.prototype, Symbol.toStringTag, { value: 'Glob', configurable: true });

export default Glob;
