import { getCtsBridge } from '../node/_internal/cts-bridge';
import { join, resolvePath } from '../utils/path';

const os = import.meta.use('os');

function invalid(message: string): TypeError {
    const error = new TypeError(message) as TypeError & { code: string };
    error.code = 'ERR_INVALID_ARG_TYPE';
    return error;
}

function stringValue(value: unknown): string {
    if (typeof value === 'symbol') throw new TypeError('Cannot convert a symbol to a string');
    try {
        return String(value);
    } catch (cause) {
        if (cause instanceof TypeError && cause.message === 'cannot convert symbol to string') {
            throw new TypeError('Cannot convert a symbol to a string');
        }
        throw cause;
    }
}

export const resolveSync = (...args: [specifier?: unknown, from?: unknown, esm?: boolean]): string => {
    const [specifier, from, esm] = args;
    if (args.length === 0) throw invalid('Expected a specifier and a from path');
    if (specifier == null) throw invalid('specifier must be a string');
    if (args.length === 1) throw invalid('Expected a from path');
    if (from == null) throw invalid('from must be a string');
    if (args.length >= 3 && typeof esm !== 'boolean') throw invalid('esm must be a boolean');
    const spec = stringValue(specifier);
    const parent = stringValue(from);
    const resolve = getCtsBridge()?.resolveEsmForInspection;
    if (typeof resolve !== 'function') throw new Error('cts ESM inspection bridge unavailable');
    try {
        // Bun treats `from` as a directory, while CTS expects an importer file.
        return resolve(spec, join(resolvePath(parent, os.cwd), '__bun_resolve__.js')) as string;
    } catch (cause) {
        const code = (cause as { code?: string })?.code;
        if (code === 'ERR_UNKNOWN_BUILTIN_MODULE' && spec.startsWith('node:')) {
            const error = new Error(`No such built-in module: ${spec}`) as Error & { code: string };
            error.name = 'ResolveMessage';
            error.code = code;
            throw error;
        }
        if (code === 'ERR_INVALID_MODULE_SPECIFIER' && spec === '') {
            const message = parent === ''
                ? "Cannot find package '' from ''"
                : `Cannot find module '' imported from ${parent}`;
            const error = new Error(message) as Error & { code: string };
            error.name = 'ResolveMessage';
            error.code = 'ERR_MODULE_NOT_FOUND';
            throw error;
        }
        if (code !== 'MODULE_NOT_FOUND' && code !== 'ENOENT' && code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw cause;
        const kind = spec.startsWith('.') || spec.startsWith('/') || !spec ? 'module' : 'package';
        const error = new Error(`Cannot find ${kind} '${spec}' imported from ${parent}`) as Error & { code: string };
        error.name = 'ResolveMessage';
        error.code = 'ERR_MODULE_NOT_FOUND';
        throw error;
    }
};

export const resolve = async (...args: [specifier?: unknown, from?: unknown, esm?: boolean]): Promise<string> => {
    return Reflect.apply(resolveSync, undefined, args);
};

Object.defineProperties(resolveSync, {
    length: { value: 1, configurable: true },
});
Object.defineProperties(resolve, {
    length: { value: 1, configurable: true },
});
