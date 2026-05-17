/**
 * Node.js repl module (stub)
 * Read-Eval-Print Loop interactive shell
 */

export interface ReplOptions {
    prompt?: string;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    terminal?: boolean;
    eval?: (evalCmd: string, context: any, file: string, cb: (err: Error | null, result?: any) => void) => void;
    useColors?: boolean;
    useGlobal?: boolean;
    ignoreUndefined?: boolean;
    writer?: (output: any) => string;
    completer?: (line: string, callback: (err: Error | null, completions: [string[], string]) => void) => void;
    replMode?: symbol;
    breakEvalOnSigint?: boolean;
}

export class REPLServer {
    defineCommand(_keyword: string, _cmd: { help?: string; action: (repl: REPLServer) => void }): void {}
    displayPrompt(_preserveCursor?: boolean): void {}
}

export function start(options?: ReplOptions | string): REPLServer {
    return new REPLServer();
}

export const REPL_MODE_SLOPPY = Symbol('repl-sloppy');
export const REPL_MODE_STRICT = Symbol('repl-strict');
export const builtinModules: string[] = [];
export const recoveredFromError = false;
