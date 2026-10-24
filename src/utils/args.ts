const os = import.meta.use('os');

import { isAbsolutePath, isDrivePath, resolvePath } from './path';

export interface EvalToken {
    /** Exact option spelling used to select eval/print mode. */
    flag: '-e' | '--eval' | '-p' | '--print' | '-pe' | '-ep';
    /** Whether the source was joined to the option with `=`. */
    inline: boolean;
}

export interface Args {
    binary: string;
    internalArgs: string[];
    action?: string;
    actionArgs: string[];
    entry: string;
    args: string[];
    /** Explicit lossless metadata for eval/print; absent for subcommand form. */
    evalToken?: EvalToken;
    /** Canonical layered argv names used by the CLI and runtime bridges. */
    kernelArgs?: string[];
    commandArgs?: string[];
    scriptArgs?: string[];
}

export interface NormalizedArgs extends Args {
    kernelArgs: string[];
    commandArgs: string[];
    scriptArgs: string[];
}

/** Keep the old field names as storage and expose live, non-copying aliases. */
export function normalizeArgs(value: Args): NormalizedArgs {
    const out: Args = {
        binary: value.binary,
        internalArgs: value.kernelArgs ?? value.internalArgs,
        actionArgs: value.commandArgs ?? value.actionArgs,
        entry: value.entry,
        args: value.scriptArgs ?? value.args,
    };
    if (value.action !== undefined) out.action = value.action;
    if (value.evalToken !== undefined) out.evalToken = value.evalToken;
    for (const [alias, field] of [
        ['kernelArgs', 'internalArgs'], ['commandArgs', 'actionArgs'], ['scriptArgs', 'args'],
    ] as const) {
        Object.defineProperty(out, alias, {
            get: () => out[field],
            set: (tokens: string[]) => { out[field] = tokens; },
            configurable: true,
        });
    }
    return out as NormalizedArgs;
}

// Single source of truth for the CLI vocabulary, shared with cno-cli so the
// two parsers cannot drift.
export const SUBCOMMANDS = [
    'run', 'serve', 'task', 'eval', 'cache', 'pack', 'repl', 'exec',
    'test', 'setup', 'help', 'version',
] as const;
export type Subcommand = typeof SUBCOMMANDS[number];
const SUBCOMMAND_SET = new Set<string>(SUBCOMMANDS);

/**
 * Deno-like argv parse — the fallback used when cno-cli does not setArgs first.
 * Once the entry is found, every remaining token (flags included) is a script
 * arg; `argv` excludes the binary (os.args[0]).
 */
export function parseArgs(argv: string[], binary: string): NormalizedArgs {
    const out: Args = { binary, internalArgs: [], actionArgs: [], entry: 'repl', args: [] };
    let i = 0;
    // Only the prefix before the command belongs to the kernel. The explicit
    // command token is the ownership boundary; command flags remain in
    // actionArgs and are intentionally invisible to the kernel.
    for (let arg = argv[i]; arg !== undefined && arg[0] === '-' && arg !== '-' && arg !== '--'; arg = argv[i]) {
        out.internalArgs.push(arg);
        i++;
    }
    const terminated = argv[i] === '--';
    if (terminated) i++;
    const action = argv[i];
    if (action !== undefined) {
        if (!terminated && SUBCOMMAND_SET.has(action)) {
            out.action = action;
            i++;
            for (let arg = argv[i]; arg !== undefined && arg[0] === '-' && arg !== '-' && arg !== '--'; arg = argv[i]) {
                out.actionArgs.push(arg);
                i++;
            }
            if (argv[i] === '--') i++;
        } else {
            out.action = 'run';
        }
        const entry = argv[i];
        if (entry !== undefined) {
            out.entry = entry;
            i++;
        }
        for (let arg = argv[i]; arg !== undefined; arg = argv[i]) {
            out.args.push(arg);
            i++;
        }
    }
    return normalizeArgs(out);
}

// Initial value from the raw process argv. cno-cli replaces this via setArgs
// before any user code runs; the standalone submodule keeps it.
let args: NormalizedArgs = parseArgs(os.args.slice(1), os.args[0]);

export default function setArgs(usrargs: Args) {
    args = normalizeArgs(usrargs);
    const refresh = Reflect.get(os, '__cno_process_args_refresh');
    if (typeof refresh === 'function') refresh();
}

export function getArgs(): NormalizedArgs {
    return args;
}

// The ONLY place argv shapes are computed: Deno and Node both derive from the
// same Args, so they can never disagree.

/** Deno.args — user args after the entry only; not the entry, not cno's flags. */
export function buildDenoArgs(): string[] {
    return [...args.scriptArgs];
}

/** True for real filesystem entries: not `repl`, not `eval:`, not a URL. */
function isFsEntry(entry: string): boolean {
    if (entry === 'repl' || entry === '-' || entry === '') return false;
    if (isAbsolutePath(entry) || isDrivePath(entry)) return true;
    return !/^[a-z][a-z0-9+\-.]*:/i.test(entry);
}

// cno stores eval source in `entry` with action 'eval', while Node treats it as
// a runtime flag: node -e "CODE" a b → argv [execPath, 'a', 'b'], execArgv
// ['-e', 'CODE']. Deno.args only exposes args.scriptArgs and is unaffected.

function isEvalMode(): boolean {
    return args.action === 'eval';
}

/** Build Node's exact eval/print execArgv representation from parser metadata. */
function evalExecArgvTokens(code: string): string[] {
    const token = args.evalToken;
    if (!token) return ['-e', code];
    return token.inline ? [`${token.flag}=${code}`] : [token.flag, code];
}

/** Node process.argv — [execPath, entry, ...scriptArgs]; argv[1] is absolute. */
export function buildNodeArgv(): string[] {
    // Eval source is not an entry: argv holds only the trailing user args.
    if (isEvalMode()) return [args.binary, ...args.scriptArgs];

    let entry = args.entry;
    if (isFsEntry(entry) && !isAbsolutePath(entry)) {
        try {
            entry = resolvePath(entry, os.cwd);
        } catch { /* no cwd — keep the raw entry */ }
    }
    return [args.binary, entry, ...args.scriptArgs];
}

/** Node process.argv0 — the name cno was invoked as. */
export function buildNodeArgv0(): string {
    return args.binary;
}

/** Node process.execArgv — runtime flags before the subcommand. */
export function buildNodeExecArgv(): string[] {
    if (!isEvalMode()) return [...args.kernelArgs];
    return [...args.kernelArgs, ...evalExecArgvTokens(args.entry)];
}

// Shared namespace on `os` so cno/src/node/* can reach these without importing
// across the node/ boundary (see AGENT.md).
Reflect.set(os, '__cno_args', {
    set: setArgs,
    get: getArgs,
    denoArgs: buildDenoArgs,
    nodeArgv: buildNodeArgv,
    nodeArgv0: buildNodeArgv0,
    nodeExecArgv: buildNodeExecArgv,
});
