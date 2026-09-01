const os = import.meta.use('os');

import { isAbsolutePath, isDrivePath, resolvePath } from './path';

export interface EvalToken {
    /** Exact option spelling used to select eval/print mode. */
    flag: '-e' | '--eval' | '-p' | '--print';
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
}

// Single source of truth for the CLI vocabulary. cno-cli imports this instead
// of keeping its own copy, so the two parsers can never drift.
export const SUBCOMMANDS = [
    'run', 'serve', 'task', 'eval', 'cache', 'pack', 'repl', 'exec',
    'test', 'setup', 'help', 'version',
] as const;
export type Subcommand = typeof SUBCOMMANDS[number];
const SUBCOMMAND_SET = new Set<string>(SUBCOMMANDS);

/**
 * Deno-liked argv parse — the fallback used when the cno submodule runs on its
 * own (no cno-cli front-end). cno-cli has a richer parser (src/cli.ts) and
 * overrides the result via setArgs, so this only needs to get the boundaries
 * right:
 *
 *   cno --internal=x run --run-args=1 main.js --user-args=y zzz
 *        internalArgs   action actionArgs entry  ──── args ────
 *
 * Once the entry is found, every remaining token (flags included) is a script
 * arg. `argv` excludes the binary (os.args[0]).
 */
export function parseArgs(argv: string[], binary: string): Args {
    const out: Args = { binary, internalArgs: [], actionArgs: [], entry: 'repl', args: [] };
    let i = 0;
    for (let arg = argv[i]; arg !== undefined && arg[0] === '-'; arg = argv[i]) {
        out.internalArgs.push(arg);
        i++;
    }
    const action = argv[i];
    if (action !== undefined) {
        if (SUBCOMMAND_SET.has(action)) {
            out.action = action;
            i++;
            for (let arg = argv[i]; arg !== undefined && arg[0] === '-'; arg = argv[i]) {
                out.actionArgs.push(arg);
                i++;
            }
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
    return out;
}

// Initial value from the raw process argv. cno-cli replaces this via setArgs
// before any user code runs; the standalone submodule keeps it.
let args: Args = parseArgs(os.args.slice(1), os.args[0]);

export default function setArgs(usrargs: Args) {
    args = usrargs;
    const refresh = Reflect.get(os, '__cno_process_args_refresh');
    if (typeof refresh === 'function') refresh();
}

export function getArgs(): Args {
    return args;
}

// ── argv derivations: the ONLY place argv shapes are computed ──────────────
// Deno and Node both derive from the same Args so they can never disagree.

/** Deno.args — user args after the entry only; not the entry, not cno's flags. */
export function buildDenoArgs(): string[] {
    return [...args.args];
}

/** True for real filesystem entries: not `repl`, not `eval:`, not a URL. */
function isFsEntry(entry: string): boolean {
    if (entry === 'repl' || entry === '-' || entry === '') return false;
    if (isAbsolutePath(entry) || isDrivePath(entry)) return true;
    return !/^[a-z][a-z0-9+\-.]*:/i.test(entry);
}

// ── eval mode (-e / -p / --eval / --print) ─────────────────────────────────
// Node treats eval source as a *runtime flag*, not a script: it lands in
// execArgv and argv stays [execPath, ...userArgs]. cno's Args carries the
// source in `entry` with action 'eval', so both Node derivations must
// special-case it — otherwise the source text is emitted as argv[1] and even
// join(cwd, …)-ed into a bogus path.
//
//   node -e "CODE" a b  → argv [execPath, 'a', 'b']   execArgv ['-e', 'CODE']
//
// Deno.args is unaffected: it only ever exposes args.args (verified below).

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
    if (isEvalMode()) return [args.binary, ...args.args];

    let entry = args.entry;
    if (isFsEntry(entry) && !isAbsolutePath(entry)) {
        try {
            entry = resolvePath(entry, os.cwd);
        } catch { /* no cwd — keep the raw entry */ }
    }
    return [args.binary, entry, ...args.args];
}

/** Node process.argv0 — the name cno was invoked as. */
export function buildNodeArgv0(): string {
    return args.binary;
}

/** Node process.execArgv — runtime flags before the subcommand. */
export function buildNodeExecArgv(): string[] {
    if (!isEvalMode()) return [...args.internalArgs];
    // Eval spelling is carried explicitly by Args.evalToken. internalArgs
    // contains only runtime options, so no global argv scan or filtering is
    // needed and user tokens cannot be mistaken for an eval selector.
    return [...args.internalArgs, ...evalExecArgvTokens(args.entry)];
}

// Shared namespace on `os` so cno/src/node/* can reach these without importing
// across the node/ boundary (see AGENT.md: node modules must go through
// import.meta.use()). deno/ code imports the builders directly instead.
Reflect.set(os, '__cno_args', {
    set: setArgs,
    get: getArgs,
    denoArgs: buildDenoArgs,
    nodeArgv: buildNodeArgv,
    nodeArgv0: buildNodeArgv0,
    nodeExecArgv: buildNodeExecArgv,
});
