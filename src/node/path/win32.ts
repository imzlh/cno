import { posixPathApi, win32PathApi } from './_shared';

const win32Path = win32PathApi;

export const sep = win32Path.sep;
export const delimiter = win32Path.delimiter;
export const _makeLong = win32Path._makeLong;
export const basename = win32Path.basename;
export const dirname = win32Path.dirname;
export const extname = win32Path.extname;
export const format = win32Path.format;
export const isAbsolute = win32Path.isAbsolute;
export const join = win32Path.join;
export const normalize = win32Path.normalize;
export const parse = win32Path.parse;
export const relative = win32Path.relative;
export const resolve = win32Path.resolve;
export const toNamespacedPath = win32Path.toNamespacedPath;
export const posix = posixPathApi;
export const win32 = win32PathApi;

export default win32Path;
