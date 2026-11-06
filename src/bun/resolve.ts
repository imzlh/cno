import { getCtsBridge } from '../node/_internal/cts-bridge';
import { join, resolvePath } from '../utils/path';

const os = import.meta.use('os');

function invalid(message: string): TypeError {
    const error = new TypeError(message) as TypeError & { code: string };
    error.code = 'ERR_INVALID_ARG_TYPE';
    return error;
}

export const resolveSync = (...args: [specifier?: unknown, from?: unknown, esm?: boolean]): string => {
    const [specifier, from, esm] = args;
    if (args.length === 0) throw invalid('Expected a specifier and a from path');
    if (esm !== undefined && typeof esm !== 'boolean') throw invalid('esm must be a boolean');
    if (specifier == null) throw invalid('specifier must be a string');
    if (args.length === 1) throw invalid('Expected a from path');
    if (from == null) throw invalid('from must be a string');
    const spec = String(specifier);
    const parent = String(from);
    const resolve = getCtsBridge()?.resolveEsmForInspection;
    if (typeof resolve !== 'function') throw new Error('cts ESM inspection bridge unavailable');
    try {
        // Bun treats `from` as a directory, while CTS expects an importer file.
        return resolve(spec, join(resolvePath(parent, os.cwd), '__bun_resolve__.js')) as string;
    } catch (cause) {
        const code = (cause as { code?: string })?.code;
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
