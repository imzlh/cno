import { hasErrno } from './errno';
import { pathParents } from './path';

const fs = import.meta.use('fs');
const asyncfs = import.meta.use('asyncfs');
const error = import.meta.use('error');

function fileExistsError(path: string): Error {
    return new Error('Cannot create directory ' + path + ': File exists');
}

/**
 * Ensure every filesystem parent of path is a directory.
 *
 * This helper belongs to the host-path compatibility layer. Only ENOENT and
 * a losing EEXIST mkdir race are recoverable here.
 */
export function ensureDirectorySync(path: string, mode?: number): void {
    for (const current of pathParents(path)) {
        try {
            if (fs.stat(current).isDirectory) continue;
            throw fileExistsError(current);
        } catch (statError) {
            if (!hasErrno(statError, error.errno.ENOENT)) throw statError;
            try {
                fs.mkdir(current, mode);
            } catch (mkdirError) {
                if (!hasErrno(mkdirError, error.errno.EEXIST)) throw mkdirError;
                if (fs.stat(current).isDirectory) continue;
                throw mkdirError;
            }
        }
    }
}

export async function ensureDirectory(path: string, mode?: number): Promise<void> {
    for (const current of pathParents(path)) {
        try {
            if ((await asyncfs.stat(current)).isDirectory) continue;
            throw fileExistsError(current);
        } catch (statError) {
            if (!hasErrno(statError, error.errno.ENOENT)) throw statError;
            try {
                await asyncfs.mkdir(current, mode);
            } catch (mkdirError) {
                if (!hasErrno(mkdirError, error.errno.EEXIST)) throw mkdirError;
                if ((await asyncfs.stat(current)).isDirectory) continue;
                throw mkdirError;
            }
        }
    }
}
