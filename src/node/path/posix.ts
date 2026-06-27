// @ts-ignore - deno-styled jsr import
export * from 'jsr:@std/path/posix';

// @ts-ignore
import * as posixNs from 'jsr:@std/path/posix';

export const sep = '/';
export const delimiter = ':';

export default {
    ...posixNs,
    sep,
    delimiter,
};
