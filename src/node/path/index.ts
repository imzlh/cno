import { posixPathApi, win32PathApi } from './_shared';

const posixCompat = posixPathApi;
const win32Compat = win32PathApi;
const platformPath = process.platform === 'win32' ? win32Compat : posixCompat;

export const sep = platformPath.sep;
export const delimiter = platformPath.delimiter;
export const _makeLong = platformPath._makeLong;
export const basename = platformPath.basename;
export const dirname = platformPath.dirname;
export const extname = platformPath.extname;
export const format = platformPath.format;
export const isAbsolute = platformPath.isAbsolute;
export const join = platformPath.join;
export const matchesGlob = platformPath.matchesGlob;
export const normalize = platformPath.normalize;
export const parse = platformPath.parse;
export const relative = platformPath.relative;
export const resolve = platformPath.resolve;
export const toNamespacedPath = platformPath.toNamespacedPath;

export const posix = posixCompat;
export const win32 = win32Compat;

export default {
    basename,
    delimiter,
    dirname,
    extname,
    format,
    isAbsolute,
    join,
    matchesGlob,
    normalize,
    parse,
    posix: posixCompat,
    relative,
    resolve,
    sep,
    toNamespacedPath,
    win32: win32Compat,
    _makeLong,
} as typeof import('node:path');
