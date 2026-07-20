import { matchesErrnoCode, normalizeErrnoError, wrapPromise, wrapSync } from '../_internal/errno';
import path from '../path';
import { assertCopyFileMode, mkdirRecursive, mkdirRecursiveSync } from './utils';

const { dirname, isAbsolute, join, parse, relative, resolve } = path;
const fs = import.meta.use('fs');
const asfs = import.meta.use('asyncfs');

interface CopyOptionsBase {
    dereference?: boolean;
    errorOnExist?: boolean;
    force?: boolean;
    mode?: number;
    preserveTimestamps?: boolean;
    recursive?: boolean;
    verbatimSymlinks?: boolean;
}

export interface CopyOptions extends CopyOptionsBase {
    filter?: (source: string, destination: string) => boolean | Promise<boolean>;
}

export interface CopySyncOptions extends CopyOptionsBase {
    filter?: (source: string, destination: string) => boolean;
}

export interface ResolvedCopyOptions {
    dereference: boolean;
    errorOnExist: boolean;
    filter?: (source: string, destination: string) => boolean | Promise<boolean>;
    force: boolean;
    mode: number;
    preserveTimestamps: boolean;
    recursive: boolean;
    verbatimSymlinks: boolean;
}

function invalidArgType(name: string, expected: string, value: unknown): TypeError {
    const error = new TypeError(`The "${name}" property must be of type ${expected}. Received ${String(value)}`);
    Reflect.set(error, 'code', 'ERR_INVALID_ARG_TYPE');
    return error;
}

function validateBooleanOption(name: string, value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw invalidArgType(`options.${name}`, 'boolean', value);
    return value;
}

export function validateCopyOptions(options?: CopyOptions | CopySyncOptions): ResolvedCopyOptions {
    if (options === undefined) {
        return {
            dereference: false,
            errorOnExist: false,
            force: true,
            mode: 0,
            preserveTimestamps: false,
            recursive: false,
            verbatimSymlinks: false,
        };
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw invalidArgType('options', 'object', options);
    }

    const dereference = validateBooleanOption('dereference', options.dereference, false);
    const verbatimSymlinks = validateBooleanOption('verbatimSymlinks', options.verbatimSymlinks, false);
    if (dereference && verbatimSymlinks) {
        const error = new TypeError('Option "dereference" cannot be used in combination with option "verbatimSymlinks"');
        Reflect.set(error, 'code', 'ERR_INCOMPATIBLE_OPTION_PAIR');
        throw error;
    }
    if (options.filter !== undefined && typeof options.filter !== 'function') {
        throw invalidArgType('options.filter', 'function', options.filter);
    }
    const mode = options.mode ?? 0;
    if (!Number.isInteger(mode) || mode < 0 || mode > 7) {
        const error = new TypeError(`The value of "options.mode" is out of range. It must be >= 0 && <= 7. Received ${String(mode)}`);
        Reflect.set(error, 'code', 'ERR_OUT_OF_RANGE');
        throw error;
    }

    return {
        dereference,
        errorOnExist: validateBooleanOption('errorOnExist', options.errorOnExist, false),
        filter: options.filter,
        force: validateBooleanOption('force', options.force, true),
        mode,
        preserveTimestamps: validateBooleanOption('preserveTimestamps', options.preserveTimestamps, false),
        recursive: validateBooleanOption('recursive', options.recursive, false),
        verbatimSymlinks,
    };
}

function cpError(code: string, errno: number, message: string, errorPath: string): NodeJS.ErrnoException {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    error.errno = errno;
    error.syscall = 'cp';
    error.path = errorPath;
    return error;
}

function identical(
    source: Pick<CModuleFS.Stats, 'dev' | 'ino'> | Pick<CModuleAsyncFS.StatResult, 'dev' | 'ino'>,
    destination: Pick<CModuleFS.Stats, 'dev' | 'ino'> | Pick<CModuleAsyncFS.StatResult, 'dev' | 'ino'>,
): boolean {
    return source.dev !== 0 && source.ino !== 0 &&
        source.dev === destination.dev && source.ino === destination.ino;
}

function isSubdirectory(source: string, destination: string): boolean {
    const rel = relative(resolve(source), resolve(destination));
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !isAbsolute(rel);
}

async function asyncStat(target: string, dereference: boolean): Promise<CModuleAsyncFS.StatResult> {
    const operation = dereference ? asfs.stat(target) : asfs.lstat(target);
    return await wrapPromise(operation, dereference ? 'stat' : 'lstat', target);
}

async function asyncStatIfExists(target: string, dereference: boolean): Promise<CModuleAsyncFS.StatResult | null> {
    try {
        return await asyncStat(target, dereference);
    } catch (error) {
        if (matchesErrnoCode(error, 'ENOENT')) return null;
        throw error;
    }
}

function syncStat(target: string, dereference: boolean): CModuleFS.Stats {
    return wrapSync(() => dereference ? fs.stat(target) : fs.lstat(target), dereference ? 'stat' : 'lstat', target);
}

function syncStatIfExists(target: string, dereference: boolean): CModuleFS.Stats | null {
    try {
        return syncStat(target, dereference);
    } catch (error) {
        if (matchesErrnoCode(error, 'ENOENT')) return null;
        throw error;
    }
}

function checkPathTypes(
    sourceStat: Pick<CModuleFS.Stats, 'isDirectory'> | Pick<CModuleAsyncFS.StatResult, 'isDirectory'>,
    destinationStat: Pick<CModuleFS.Stats, 'isDirectory'> | Pick<CModuleAsyncFS.StatResult, 'isDirectory'> | null,
    source: string,
    destination: string,
): void {
    if (destinationStat) {
        if (sourceStat.isDirectory && !destinationStat.isDirectory) {
            throw cpError(
                'ERR_FS_CP_DIR_TO_NON_DIR',
                21,
                `Cannot overwrite non-directory ${destination} with directory ${source}`,
                destination,
            );
        }
        if (!sourceStat.isDirectory && destinationStat.isDirectory) {
            throw cpError(
                'ERR_FS_CP_NON_DIR_TO_DIR',
                20,
                `Cannot overwrite directory ${destination} with non-directory ${source}`,
                destination,
            );
        }
    }
    if (sourceStat.isDirectory && isSubdirectory(source, destination)) {
        throw cpError(
            'ERR_FS_CP_EINVAL',
            22,
            `Cannot copy ${source} to a subdirectory of self ${destination}`,
            destination,
        );
    }
}

async function checkAsyncParentPaths(source: string, sourceStat: CModuleAsyncFS.StatResult, destination: string): Promise<void> {
    const sourceParent = resolve(dirname(source));
    let destinationParent = resolve(dirname(destination));
    while (destinationParent !== sourceParent && destinationParent !== parse(destinationParent).root) {
        const destinationStat = await asyncStatIfExists(destinationParent, true);
        if (!destinationStat) return;
        if (identical(sourceStat, destinationStat)) {
            throw cpError(
                'ERR_FS_CP_EINVAL',
                22,
                `Cannot copy ${source} to a subdirectory of self ${destination}`,
                destination,
            );
        }
        destinationParent = resolve(dirname(destinationParent));
    }
}

function checkSyncParentPaths(source: string, sourceStat: CModuleFS.Stats, destination: string): void {
    const sourceParent = resolve(dirname(source));
    let destinationParent = resolve(dirname(destination));
    while (destinationParent !== sourceParent && destinationParent !== parse(destinationParent).root) {
        const destinationStat = syncStatIfExists(destinationParent, true);
        if (!destinationStat) return;
        if (identical(sourceStat, destinationStat)) {
            throw cpError(
                'ERR_FS_CP_EINVAL',
                22,
                `Cannot copy ${source} to a subdirectory of self ${destination}`,
                destination,
            );
        }
        destinationParent = resolve(dirname(destinationParent));
    }
}

async function copyAsyncFile(
    sourceStat: CModuleAsyncFS.StatResult,
    destinationStat: CModuleAsyncFS.StatResult | null,
    source: string,
    destination: string,
    options: ResolvedCopyOptions,
): Promise<void> {
    if (destinationStat) {
        if (!options.force) {
            if (options.errorOnExist) {
                throw cpError('ERR_FS_CP_EEXIST', 17, `Target already exists: ${destination}`, destination);
            }
            return;
        }
        await wrapPromise(asfs.unlink(destination), 'unlink', destination);
    }

    assertCopyFileMode(source, destination, options.mode);
    await wrapPromise(asfs.copyFile(source, destination), 'copyfile', source, destination);
    if (options.preserveTimestamps) {
        if ((sourceStat.mode & 0o200) === 0) {
            await wrapPromise(asfs.chmod(destination, sourceStat.mode | 0o200), 'chmod', destination);
        }
        const updatedSourceStat = await asyncStat(source, true);
        await wrapPromise(
            asfs.utime(destination, updatedSourceStat.atim.getTime(), updatedSourceStat.mtim.getTime()),
            'utime',
            destination,
        );
    }
    await wrapPromise(asfs.chmod(destination, sourceStat.mode), 'chmod', destination);
}

function copySyncFile(
    sourceStat: CModuleFS.Stats,
    destinationStat: CModuleFS.Stats | null,
    source: string,
    destination: string,
    options: ResolvedCopyOptions,
): void {
    if (destinationStat) {
        if (!options.force) {
            if (options.errorOnExist) {
                throw cpError('ERR_FS_CP_EEXIST', 17, `Target already exists: ${destination}`, destination);
            }
            return;
        }
        wrapSync(() => fs.unlink(destination), 'unlink', destination);
    }

    wrapSync(() => {
        assertCopyFileMode(source, destination, options.mode);
        fs.copy(source, destination);
    }, 'copyfile', source, destination);
    if (options.preserveTimestamps) {
        if ((sourceStat.mode & 0o200) === 0) {
            wrapSync(() => fs.chmod(destination, sourceStat.mode | 0o200), 'chmod', destination);
        }
        const updatedSourceStat = syncStat(source, true);
        wrapSync(
            () => fs.utimes(destination, updatedSourceStat.atim.getTime() / 1000, updatedSourceStat.mtim.getTime() / 1000),
            'utime',
            destination,
        );
    }
    wrapSync(() => fs.chmod(destination, sourceStat.mode), 'chmod', destination);
}

async function copyAsyncLink(
    destinationStat: CModuleAsyncFS.StatResult | null,
    source: string,
    destination: string,
    options: ResolvedCopyOptions,
): Promise<void> {
    let sourceTarget = await wrapPromise(asfs.readLink(source), 'readlink', source);
    if (!options.verbatimSymlinks && !isAbsolute(sourceTarget)) {
        sourceTarget = resolve(dirname(source), sourceTarget);
    }
    if (!destinationStat) {
        await wrapPromise(asfs.symlink(sourceTarget, destination, 0), 'symlink', sourceTarget, destination);
        return;
    }

    let destinationTarget: string;
    try {
        destinationTarget = await wrapPromise(asfs.readLink(destination), 'readlink', destination);
    } catch (error) {
        if (matchesErrnoCode(error, 'EINVAL', 'UNKNOWN')) {
            await wrapPromise(asfs.symlink(sourceTarget, destination, 0), 'symlink', sourceTarget, destination);
            return;
        }
        throw error;
    }
    if (!isAbsolute(destinationTarget)) destinationTarget = resolve(dirname(destination), destinationTarget);

    const followedSource = await asyncStat(source, true);
    if (followedSource.isDirectory && isSubdirectory(sourceTarget, destinationTarget)) {
        throw cpError('ERR_FS_CP_EINVAL', 22, `Cannot copy ${sourceTarget} to ${destinationTarget}`, destination);
    }
    if (followedSource.isDirectory && isSubdirectory(destinationTarget, sourceTarget)) {
        throw cpError(
            'ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY',
            22,
            `Cannot overwrite ${destinationTarget} with ${sourceTarget}`,
            destination,
        );
    }
    await wrapPromise(asfs.unlink(destination), 'unlink', destination);
    await wrapPromise(asfs.symlink(sourceTarget, destination, 0), 'symlink', sourceTarget, destination);
}

function copySyncLink(
    destinationStat: CModuleFS.Stats | null,
    source: string,
    destination: string,
    options: ResolvedCopyOptions,
): void {
    let sourceTarget = wrapSync(() => fs.readlink(source), 'readlink', source);
    if (!options.verbatimSymlinks && !isAbsolute(sourceTarget)) {
        sourceTarget = resolve(dirname(source), sourceTarget);
    }
    if (!destinationStat) {
        wrapSync(() => fs.symlink(sourceTarget, destination), 'symlink', sourceTarget, destination);
        return;
    }

    let destinationTarget: string;
    try {
        destinationTarget = wrapSync(() => fs.readlink(destination), 'readlink', destination);
    } catch (error) {
        if (matchesErrnoCode(error, 'EINVAL', 'UNKNOWN')) {
            wrapSync(() => fs.symlink(sourceTarget, destination), 'symlink', sourceTarget, destination);
            return;
        }
        throw error;
    }
    if (!isAbsolute(destinationTarget)) destinationTarget = resolve(dirname(destination), destinationTarget);

    const followedSource = syncStat(source, true);
    if (followedSource.isDirectory && isSubdirectory(sourceTarget, destinationTarget)) {
        throw cpError('ERR_FS_CP_EINVAL', 22, `Cannot copy ${sourceTarget} to ${destinationTarget}`, destination);
    }
    if (followedSource.isDirectory && isSubdirectory(destinationTarget, sourceTarget)) {
        throw cpError(
            'ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY',
            22,
            `Cannot overwrite ${destinationTarget} with ${sourceTarget}`,
            destination,
        );
    }
    wrapSync(() => fs.unlink(destination), 'unlink', destination);
    wrapSync(() => fs.symlink(sourceTarget, destination), 'symlink', sourceTarget, destination);
}

async function copyAsyncEntry(
    source: string,
    destination: string,
    options: ResolvedCopyOptions,
    root = false,
): Promise<void> {
    if (options.filter && !await options.filter(source, destination)) return;

    const sourceStat = await asyncStat(source, options.dereference);
    const destinationStat = await asyncStatIfExists(destination, options.dereference);
    if (destinationStat && identical(sourceStat, destinationStat)) {
        throw cpError('ERR_FS_CP_EINVAL', 22, `src and dest cannot be the same: ${destination}`, destination);
    }
    checkPathTypes(sourceStat, destinationStat, source, destination);
    if (root) await checkAsyncParentPaths(source, sourceStat, destination);

    const destinationParent = dirname(destination);
    if (destinationParent && destinationParent !== destination) {
        await mkdirRecursive(destinationParent);
    }

    if (sourceStat.isDirectory) {
        if (!options.recursive) {
            throw cpError('ERR_FS_EISDIR', 21, `${source} is a directory (not copied)`, source);
        }
        if (destinationStat && options.errorOnExist && !options.force) {
            throw cpError('ERR_FS_CP_EEXIST', 17, `Target already exists: ${destination}`, destination);
        }
        const created = destinationStat === null;
        if (created) await wrapPromise(asfs.mkdir(destination), 'mkdir', destination);
        const directory = await wrapPromise(asfs.readDir(source), 'opendir', source);
        try {
            for await (const entry of directory) {
                await copyAsyncEntry(join(source, entry.name), join(destination, entry.name), options);
            }
        } finally {
            await directory.close();
        }
        if (created) await wrapPromise(asfs.chmod(destination, sourceStat.mode), 'chmod', destination);
        return;
    }
    if (sourceStat.isFile || sourceStat.isCharacterDevice || sourceStat.isBlockDevice) {
        await copyAsyncFile(sourceStat, destinationStat, source, destination, options);
        return;
    }
    if (sourceStat.isSymbolicLink) {
        await copyAsyncLink(destinationStat, source, destination, options);
        return;
    }
    if (sourceStat.isSocket) {
        throw cpError('ERR_FS_CP_SOCKET', 22, `Cannot copy a socket file: ${destination}`, destination);
    }
    if (sourceStat.isFIFO) {
        throw cpError('ERR_FS_CP_FIFO_PIPE', 22, `Cannot copy a FIFO pipe: ${destination}`, destination);
    }
    throw cpError('ERR_FS_CP_UNKNOWN', 22, `Cannot copy an unknown file type: ${destination}`, destination);
}

function copySyncEntry(
    source: string,
    destination: string,
    options: ResolvedCopyOptions,
    root = false,
): void {
    if (options.filter) {
        const filtered = options.filter(source, destination);
        if (filtered instanceof Promise) {
            const error = new TypeError('Expected a boolean to be returned from the "filter" function but got an instance of Promise.');
            Reflect.set(error, 'code', 'ERR_INVALID_RETURN_VALUE');
            throw error;
        }
        if (!filtered) return;
    }

    const sourceStat = syncStat(source, options.dereference);
    const destinationStat = syncStatIfExists(destination, options.dereference);
    if (destinationStat && identical(sourceStat, destinationStat)) {
        throw cpError('ERR_FS_CP_EINVAL', 22, `src and dest cannot be the same: ${destination}`, destination);
    }
    checkPathTypes(sourceStat, destinationStat, source, destination);
    if (root) checkSyncParentPaths(source, sourceStat, destination);

    const destinationParent = dirname(destination);
    if (destinationParent && destinationParent !== destination) {
        mkdirRecursiveSync(destinationParent);
    }

    if (sourceStat.isDirectory) {
        if (!options.recursive) {
            throw cpError('ERR_FS_EISDIR', 21, `${source} is a directory (not copied)`, source);
        }
        const created = destinationStat === null;
        if (created) wrapSync(() => fs.mkdir(destination), 'mkdir', destination);
        for (const entry of wrapSync(() => fs.readdir(source), 'readdir', source)) {
            copySyncEntry(join(source, entry), join(destination, entry), options);
        }
        if (created) wrapSync(() => fs.chmod(destination, sourceStat.mode), 'chmod', destination);
        return;
    }
    if (sourceStat.isFile || sourceStat.isCharacterDevice || sourceStat.isBlockDevice) {
        copySyncFile(sourceStat, destinationStat, source, destination, options);
        return;
    }
    if (sourceStat.isSymbolicLink) {
        copySyncLink(destinationStat, source, destination, options);
        return;
    }
    if (sourceStat.isSocket) {
        throw cpError('ERR_FS_CP_SOCKET', 22, `Cannot copy a socket file: ${destination}`, destination);
    }
    if (sourceStat.isFIFO) {
        throw cpError('ERR_FS_CP_FIFO_PIPE', 22, `Cannot copy a FIFO pipe: ${destination}`, destination);
    }
    throw cpError('ERR_FS_CP_UNKNOWN', 22, `Cannot copy an unknown file type: ${destination}`, destination);
}

export async function copyPath(source: string, destination: string, options: ResolvedCopyOptions): Promise<void> {
    try {
        await copyAsyncEntry(source, destination, options, true);
    } catch (error) {
        throw normalizeErrnoError(error);
    }
}

export function copyPathSync(source: string, destination: string, options: ResolvedCopyOptions): void {
    try {
        copySyncEntry(source, destination, options, true);
    } catch (error) {
        throw normalizeErrnoError(error);
    }
}
