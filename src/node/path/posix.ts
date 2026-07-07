import { posixPathApi, win32PathApi } from './_shared';

const posixPath = posixPathApi;

export const sep = posixPath.sep;
export const delimiter = posixPath.delimiter;
export const _makeLong = posixPath._makeLong;
export const basename = posixPath.basename;
export const dirname = posixPath.dirname;
export const extname = posixPath.extname;
export const format = posixPath.format;
export const isAbsolute = posixPath.isAbsolute;
export const join = posixPath.join;
export const normalize = posixPath.normalize;
export const parse = posixPath.parse;
export const relative = posixPath.relative;
export const resolve = posixPath.resolve;
export const toNamespacedPath = posixPath.toNamespacedPath;
export const posix = posixPathApi;
export const win32 = win32PathApi;

export default posixPath;
