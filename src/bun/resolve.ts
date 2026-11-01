import { getCtsBridge } from '../node/_internal/cts-bridge';
import { join, resolvePath } from '../utils/path';

const os = import.meta.use('os');

function invalid(message: string): TypeError {
    const error = new TypeError(message) as TypeError & { code: string };
    error.code = 'ERR_INVALID_ARG_TYPE';
    return error;
}

export function resolveSync(specifier: unknown, from: unknown): string {
    if (arguments.length === 0) throw invalid('Expected a specifier and a from path');
    if (arguments.length === 1) throw invalid('Expected a from path');
    if (specifier == null) throw invalid('specifier must be a string');
    if (from == null) throw invalid('from must be a string');
    if (typeof specifier === 'symbol' || typeof from === 'symbol') throw new TypeError('Cannot convert a symbol to a string');
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
}

export async function resolve(specifier: unknown, from: unknown): Promise<string> {
    return Reflect.apply(resolveSync, undefined, Array.from(arguments));
}
