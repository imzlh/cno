import path from '../path';
import { pathToString, toNodeDirent, toNodeDirentAsync } from './utils';

const { basename, dirname, isAbsolute, join, relative, resolve, sep } = path;
import { nsfs, nsasfs } from './syspath';
const fs = nsfs;
const asfs = nsasfs;

export type GlobResult = string | import('fs').Dirent;
export type GlobExclude = readonly string[] | ((entry: GlobResult) => boolean);

export interface GlobOptions {
    cwd?: string | URL;
    exclude?: GlobExclude;
    followSymlinks?: boolean;
    withFileTypes?: boolean;
}

interface ResolvedGlobOptions {
    cwd: string;
    exclude?: GlobExclude;
    followSymlinks: boolean;
    withFileTypes: boolean;
}

interface GlobPattern {
    absolute: boolean;
    base: string;
    pattern: string;
    trailingSlash: boolean;
}

interface SyncGlobEntry {
    fullPath: string;
    output: string;
    dirent: import('fs').Dirent;
    directory: boolean;
}

interface AsyncGlobEntry extends SyncGlobEntry {}

function invalidArgType(name: string, expected: string, value: unknown): TypeError {
    const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${String(value)}`);
    Reflect.set(error, 'code', 'ERR_INVALID_ARG_TYPE');
    return error;
}

export function validateGlobPatterns(pattern: string | readonly string[]): string[] {
    if (typeof pattern === 'string') return [pattern];
    if (!Array.isArray(pattern)) throw invalidArgType('patterns', 'string or an Array of strings', pattern);
    const patterns: string[] = [];
    for (let index = 0; index < pattern.length; index++) {
        const item = pattern[index];
        if (typeof item !== 'string') throw invalidArgType(`patterns[${index}]`, 'string', item);
        patterns.push(item);
    }
    return patterns;
}

export function validateGlobOptions(options?: GlobOptions): ResolvedGlobOptions {
    if (options === undefined) {
        return { cwd: resolve('.'), followSymlinks: false, withFileTypes: false };
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw invalidArgType('options', 'object', options);
    }
    if (options.followSymlinks !== undefined && typeof options.followSymlinks !== 'boolean') {
        throw invalidArgType('options.followSymlinks', 'boolean', options.followSymlinks);
    }
    if (options.exclude !== undefined) {
        if (Array.isArray(options.exclude)) {
            for (let index = 0; index < options.exclude.length; index++) {
                if (typeof options.exclude[index] !== 'string') {
                    throw invalidArgType(`options.exclude[${index}]`, 'string', options.exclude[index]);
                }
            }
        } else if (typeof options.exclude !== 'function') {
            throw invalidArgType('options.exclude', 'an Array of strings or a function', options.exclude);
        }
    }
    return {
        cwd: resolve(options.cwd == null ? '.' : pathToString(options.cwd)),
        exclude: options.exclude,
        followSymlinks: options.followSymlinks ?? false,
        withFileTypes: !!options.withFileTypes,
    };
}

function splitAlternatives(value: string): string[] {
    const alternatives: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] === '{' || value[index] === '(') depth++;
        else if (value[index] === '}' || value[index] === ')') depth--;
        else if ((value[index] === ',' || value[index] === '|') && depth === 0) {
            alternatives.push(value.slice(start, index));
            start = index + 1;
        }
    }
    alternatives.push(value.slice(start));
    return alternatives;
}

function expandBraces(pattern: string): string[] {
    let start = -1;
    let depth = 0;
    for (let index = 0; index < pattern.length; index++) {
        if (pattern[index] === '{') {
            if (depth === 0) start = index;
            depth++;
        } else if (pattern[index] === '}' && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                const body = pattern.slice(start + 1, index);
                const alternatives = splitAlternatives(body);
                if (alternatives.length === 1) return [pattern];
                const expanded: string[] = [];
                for (const alternative of alternatives) {
                    for (const suffix of expandBraces(pattern.slice(index + 1))) {
                        expanded.push(pattern.slice(0, start) + alternative + suffix);
                    }
                }
                return expanded.flatMap(expandBraces);
            }
        }
    }
    return [pattern];
}

function normalizeGlobPath(value: string): string {
    const normalized = sep === '\\' ? value.replace(/\\/g, '/') : value;
    return normalized.replace(/\/+/g, '/');
}

function stripLeadingCurrent(pattern: string): string {
    let result = pattern;
    while (result.startsWith('./')) result = result.slice(2);
    return result;
}

function normalizeStaticParentSegments(pattern: string): string {
    const absolute = pattern.startsWith('/');
    const output: string[] = [];
    for (const segment of pattern.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..' && output.length > 0) {
            const previous = output[output.length - 1];
            if (previous !== '..' && !hasMagic(previous)) {
                output.pop();
                continue;
            }
        }
        output.push(segment);
    }
    const normalized = output.join('/');
    return absolute ? `/${normalized}` : normalized;
}

function hasMagic(segment: string): boolean {
    return /[*?[\]{}()]/.test(segment);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.+^$|{}\\]/g, '\\$&');
}

function findClosingParen(segment: string, start: number): number {
    let depth = 0;
    for (let index = start; index < segment.length; index++) {
        if (segment[index] === '(') depth++;
        else if (segment[index] === ')') {
            depth--;
            if (depth === 0) return index;
        }
    }
    return -1;
}

function segmentRegexSource(segment: string): string {
    let source = '';
    for (let index = 0; index < segment.length;) {
        const character = segment[index];
        const next = segment[index + 1];
        if ('@+?!*'.includes(character) && next === '(') {
            const close = findClosingParen(segment, index + 1);
            if (close !== -1) {
                const body = segment.slice(index + 2, close);
                const alternatives = splitAlternatives(body).map(segmentRegexSource).join('|');
                if (character === '@') source += `(?:${alternatives})`;
                else if (character === '+') source += `(?:${alternatives})+`;
                else if (character === '?') source += `(?:${alternatives})?`;
                else if (character === '*') source += `(?:${alternatives})*`;
                else source += `(?!(?:${alternatives})$).*`;
                index = close + 1;
                continue;
            }
        }
        if (character === '*') {
            source += '.*';
            index++;
            continue;
        }
        if (character === '?') {
            source += '.';
            index++;
            continue;
        }
        if (character === '[') {
            const close = segment.indexOf(']', index + 1);
            if (close !== -1) {
                let body = segment.slice(index + 1, close);
                if (body.startsWith('!')) body = '^' + body.slice(1);
                source += `[${body.replace(/\\/g, '\\\\')}]`;
                index = close + 1;
                continue;
            }
        }
        source += escapeRegExp(character);
        index++;
    }
    return source;
}

function segmentCanMatchDot(segment: string): boolean {
    return segment.startsWith('.') || segment.startsWith('[.]') || segment.startsWith('[\\.]');
}

function matchSegment(value: string, pattern: string): boolean {
    if (value.startsWith('.') && !segmentCanMatchDot(pattern)) return false;
    if (pattern.startsWith('!(')) {
        const close = findClosingParen(pattern, 1);
        if (close !== -1) {
            const suffix = pattern.slice(close + 1);
            if (!matchSegment(value, `*${suffix}`)) return false;
            const alternatives = splitAlternatives(pattern.slice(2, close));
            return !alternatives.some(alternative => matchSegment(value, alternative + suffix));
        }
    }
    return new RegExp(`^${segmentRegexSource(pattern)}$`).test(value);
}

function matchSegments(
    values: string[],
    patterns: string[],
    valueIndex: number,
    patternIndex: number,
    finalGlobstarRequiresEntry: boolean,
): boolean {
    if (patternIndex === patterns.length) return valueIndex === values.length;
    const pattern = patterns[patternIndex];
    if (pattern !== '**') {
        return valueIndex < values.length && matchSegment(values[valueIndex], pattern) &&
            matchSegments(values, patterns, valueIndex + 1, patternIndex + 1, finalGlobstarRequiresEntry);
    }

    if (patternIndex === patterns.length - 1) {
        if (finalGlobstarRequiresEntry && valueIndex === values.length) return false;
        for (let index = valueIndex; index < values.length; index++) {
            if (values[index].startsWith('.')) return false;
        }
        return true;
    }
    if (matchSegments(values, patterns, valueIndex, patternIndex + 1, finalGlobstarRequiresEntry)) return true;
    return valueIndex < values.length && !values[valueIndex].startsWith('.') &&
        matchSegments(values, patterns, valueIndex + 1, patternIndex, finalGlobstarRequiresEntry);
}

function matchesPattern(
    candidate: string,
    pattern: string,
    directory: boolean,
    finalGlobstarRequiresEntry = false,
): boolean {
    const normalizedPattern = stripLeadingCurrent(normalizeGlobPath(pattern));
    const trailingSlash = normalizedPattern.endsWith('/');
    if (trailingSlash && !directory) return false;
    const matchPattern = trailingSlash ? normalizedPattern.replace(/\/+$/, '') : normalizedPattern;
    const normalizedCandidate = normalizeGlobPath(candidate);
    if (normalizedCandidate === '.' && matchPattern === '**' && !finalGlobstarRequiresEntry) return true;
    const values = normalizedCandidate === '' ? [] : normalizedCandidate.split('/');
    const patterns = matchPattern === '' ? [] : matchPattern.split('/');
    return matchSegments(values, patterns, 0, 0, finalGlobstarRequiresEntry);
}

function createGlobPattern(pattern: string, cwd: string): GlobPattern | null {
    if (pattern === '') return null;
    const input = stripLeadingCurrent(normalizeGlobPath(pattern));
    const trailingSlash = input.endsWith('/');
    const normalized = normalizeStaticParentSegments(trailingSlash ? input.replace(/\/+$/, '') : input);
    const matchPattern = normalized;
    const parts = matchPattern.split('/');
    const firstMagic = parts.findIndex(hasMagic);
    let base: string;
    if (firstMagic === -1) {
        base = resolve(cwd, matchPattern);
    } else {
        let prefix = parts.slice(0, firstMagic).join('/');
        if (isAbsolute(matchPattern) && prefix === '') prefix = '/';
        base = resolve(cwd, prefix || '.');
    }
    return { absolute: isAbsolute(matchPattern), base, pattern: matchPattern, trailingSlash };
}

function outputPath(fullPath: string, cwd: string, absolute: boolean): string {
    return absolute ? resolve(fullPath) : relative(cwd, fullPath) || '.';
}

function isExcluded(entry: SyncGlobEntry, options: ResolvedGlobOptions): boolean {
    const exclude = options.exclude;
    if (!exclude) return false;
    if (typeof exclude === 'function') {
        return !!exclude(options.withFileTypes ? entry.dirent : entry.output);
    }
    for (const pattern of exclude) {
        for (const expanded of expandBraces(pattern)) {
            const candidate = isAbsolute(expanded) ? entry.fullPath : entry.output;
            if (matchesPattern(candidate, expanded, entry.directory, true)) return true;
        }
    }
    return false;
}

function addResult(
    results: GlobResult[],
    seen: Set<string>,
    entry: SyncGlobEntry,
    globPattern: GlobPattern,
    options: ResolvedGlobOptions,
): void {
    if (seen.has(entry.output)) return;
    if (!matchesPattern(entry.output, globPattern.pattern, entry.directory)) return;
    if (globPattern.trailingSlash && !entry.directory) return;
    seen.add(entry.output);
    results.push(options.withFileTypes ? entry.dirent : entry.output);
}

function syncEntry(fullPath: string, output: string, stat: CModuleFS.Stats | CModuleFS.DirEnt): SyncGlobEntry {
    let directory = stat.isDirectory;
    if (!directory && stat.isSymbolicLink) {
        try {
            directory = fs.stat(fullPath).isDirectory;
        } catch {}
    }
    return {
        fullPath,
        output,
        dirent: toNodeDirent(basename(fullPath), stat, dirname(fullPath)),
        directory,
    };
}

function scanSyncPattern(
    globPattern: GlobPattern,
    options: ResolvedGlobOptions,
    results: GlobResult[],
    seen: Set<string>,
): void {
    let baseStat: CModuleFS.Stats;
    try {
        baseStat = fs.lstat(globPattern.base);
    } catch {
        return;
    }
    const exact = !globPattern.pattern.split('/').some(hasMagic);
    const baseEntry = syncEntry(
        globPattern.base,
        outputPath(globPattern.base, options.cwd, globPattern.absolute),
        baseStat,
    );
    if (exact) {
        if (baseEntry.output !== '.' && (!globPattern.trailingSlash || baseEntry.directory) && !isExcluded(baseEntry, options)) {
            addResult(results, seen, baseEntry, globPattern, options);
        }
        return;
    }

    const walk = (entry: SyncGlobEntry, insideUnfollowedLink: boolean, ancestors: Set<string>) => {
        const excluded = entry.output !== '.' && isExcluded(entry, options);
        if (excluded) return;
        addResult(results, seen, entry, globPattern, options);
        if (!entry.directory) return;

        let nextAncestors = ancestors;
        if (options.followSymlinks) {
            try {
                const real = fs.realpath(entry.fullPath);
                if (ancestors.has(real)) return;
                nextAncestors = new Set(ancestors);
                nextAncestors.add(real);
            } catch {
                return;
            }
        }

        let children: CModuleFS.DirEnt[];
        try {
            children = fs.readdir(entry.fullPath, true);
        } catch {
            return;
        }
        for (const child of children) {
            const childFullPath = join(entry.fullPath, child.name);
            const childEntry = syncEntry(
                childFullPath,
                outputPath(childFullPath, options.cwd, globPattern.absolute),
                child,
            );
            const childExcluded = isExcluded(childEntry, options);
            if (!childExcluded) addResult(results, seen, childEntry, globPattern, options);
            if (childExcluded || !childEntry.directory || insideUnfollowedLink) continue;
            const childIsUnfollowedLink = child.isSymbolicLink && !options.followSymlinks;
            if (childIsUnfollowedLink && !globPattern.pattern.endsWith('/**/*') && globPattern.pattern !== '**/*') continue;
            walk(childEntry, childIsUnfollowedLink, nextAncestors);
        }
    };
    walk(baseEntry, false, new Set());
}

async function asyncEntry(
    fullPath: string,
    output: string,
    stat: CModuleAsyncFS.StatResult | CModuleAsyncFS.DirEnt,
): Promise<AsyncGlobEntry> {
    let directory = stat.isDirectory;
    if (!directory && stat.isSymbolicLink) {
        try {
            directory = (await asfs.stat(fullPath)).isDirectory;
        } catch {}
    }
    return {
        fullPath,
        output,
        dirent: toNodeDirentAsync(stat, dirname(fullPath), basename(fullPath)),
        directory,
    };
}

async function scanAsyncPattern(
    globPattern: GlobPattern,
    options: ResolvedGlobOptions,
    results: GlobResult[],
    seen: Set<string>,
): Promise<void> {
    let baseStat: CModuleAsyncFS.StatResult;
    try {
        baseStat = await asfs.lstat(globPattern.base);
    } catch {
        return;
    }
    const exact = !globPattern.pattern.split('/').some(hasMagic);
    const baseEntry = await asyncEntry(
        globPattern.base,
        outputPath(globPattern.base, options.cwd, globPattern.absolute),
        baseStat,
    );
    if (exact) {
        if (baseEntry.output !== '.' && (!globPattern.trailingSlash || baseEntry.directory) && !isExcluded(baseEntry, options)) {
            addResult(results, seen, baseEntry, globPattern, options);
        }
        return;
    }

    const walk = async (entry: AsyncGlobEntry, insideUnfollowedLink: boolean, ancestors: Set<string>): Promise<void> => {
        const excluded = entry.output !== '.' && isExcluded(entry, options);
        if (excluded) return;
        addResult(results, seen, entry, globPattern, options);
        if (!entry.directory) return;

        let nextAncestors = ancestors;
        if (options.followSymlinks) {
            try {
                const real = await asfs.realPath(entry.fullPath);
                if (ancestors.has(real)) return;
                nextAncestors = new Set(ancestors);
                nextAncestors.add(real);
            } catch {
                return;
            }
        }

        let directory: CModuleAsyncFS.DirHandle;
        try {
            directory = await asfs.readDir(entry.fullPath);
        } catch {
            return;
        }
        try {
            for await (const child of directory) {
                const childFullPath = join(entry.fullPath, child.name);
                const childEntry = await asyncEntry(
                    childFullPath,
                    outputPath(childFullPath, options.cwd, globPattern.absolute),
                    child,
                );
                const childExcluded = isExcluded(childEntry, options);
                if (!childExcluded) addResult(results, seen, childEntry, globPattern, options);
                if (childExcluded || !childEntry.directory || insideUnfollowedLink) continue;
                const childIsUnfollowedLink = child.isSymbolicLink && !options.followSymlinks;
                if (childIsUnfollowedLink && !globPattern.pattern.endsWith('/**/*') && globPattern.pattern !== '**/*') continue;
                await walk(childEntry, childIsUnfollowedLink, nextAncestors);
            }
        } finally {
            await directory.close();
        }
    };
    await walk(baseEntry, false, new Set());
}

function preparePatterns(patterns: string[], cwd: string): GlobPattern[] {
    const prepared: GlobPattern[] = [];
    for (const pattern of patterns) {
        for (const expanded of expandBraces(pattern)) {
            const globPattern = createGlobPattern(expanded, cwd);
            if (globPattern) prepared.push(globPattern);
        }
    }
    return prepared;
}

export function globPathsSync(pattern: string | readonly string[], options?: GlobOptions): GlobResult[] {
    const resolvedOptions = validateGlobOptions(options);
    const patterns = validateGlobPatterns(pattern);
    const results: GlobResult[] = [];
    const seen = new Set<string>();
    for (const globPattern of preparePatterns(patterns, resolvedOptions.cwd)) {
        scanSyncPattern(globPattern, resolvedOptions, results, seen);
    }
    return results;
}

export async function globPaths(pattern: string | readonly string[], options?: GlobOptions): Promise<GlobResult[]> {
    const resolvedOptions = validateGlobOptions(options);
    const patterns = validateGlobPatterns(pattern);
    const results: GlobResult[] = [];
    const seen = new Set<string>();
    for (const globPattern of preparePatterns(patterns, resolvedOptions.cwd)) {
        await scanAsyncPattern(globPattern, resolvedOptions, results, seen);
    }
    return results;
}
