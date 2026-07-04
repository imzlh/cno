const os = import.meta.use('os');

export interface Args {
    binary: string;
    internalArgs: string[];
    action?: string;
    actionArgs: string[];
    entry: string;
    args: string[];
}

// Single source of truth for the CLI vocabulary. cno-cli imports this instead
// of keeping its own copy, so the two parsers can never drift.
export const SUBCOMMANDS = [
    'run', 'task', 'eval', 'cache', 'repl', 'exec',
    'fmt', 'lint', 'test', 'upgrade', 'setup', 'help', 'version',
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
    while (i < argv.length && argv[i][0] === '-') out.internalArgs.push(argv[i++]);
    if (i < argv.length) {
        if (SUBCOMMAND_SET.has(argv[i])) {
            out.action = argv[i++];
            while (i < argv.length && argv[i][0] === '-') out.actionArgs.push(argv[i++]);
        } else {
            out.action = 'run';
        }
        if (i < argv.length) out.entry = argv[i++];
        while (i < argv.length) out.args.push(argv[i++]);
    }
    return out;
}

// Initial value from the raw process argv. cno-cli replaces this via setArgs
// before any user code runs; the standalone submodule keeps it.
let args: Args = parseArgs(os.args.slice(1), os.args[0]);

export default function setArgs(usrargs: Args) {
    args = usrargs;
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

/** Runtime process.argv — [entry, ...scriptArgs]. execPath is exposed separately. */
export function buildNodeArgv(): string[] {
    return [args.entry, ...args.args];
}

/** Node process.argv0 — the name cno was invoked as. */
export function buildNodeArgv0(): string {
    return args.binary;
}

/** Node process.execArgv — runtime flags before the subcommand. */
export function buildNodeExecArgv(): string[] {
    return [...args.internalArgs];
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
