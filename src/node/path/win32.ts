// @ts-ignore - deno-styled jsr import
export * from 'jsr:@std/path/windows';

// @ts-ignore
import * as win32Ns from 'jsr:@std/path/windows';

export const sep = '\\';
export const delimiter = ';';

export default {
    ...win32Ns,
    sep,
    delimiter,
};
