import { posixPathApi, win32PathApi } from './_shared';

const os = import.meta.use('os');

const posixCompat = posixPathApi;
const win32Compat = win32PathApi;
const sysname = os.uname().sysname;
const platformPath = os.platform === 'windows' || os.platform === 'win32' || sysname === 'Windows_NT'
    ? win32Compat
    : posixCompat;

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

// Node exports the platform flavour object itself (with .posix/.win32 already
// cross-linked on it), so `path === path.win32` holds on Windows. Rebuilding a
// fresh literal here would break that identity check for no benefit.
// No cast: `platformPath` is already a fully-typed PathApi, and casting to
// `typeof import('node:path')` referenced types this project does not ship.
export default platformPath;
