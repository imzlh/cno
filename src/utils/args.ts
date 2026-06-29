const os = import.meta.use('os');

export interface Args {
    binary: string;
    internalArgs: string[];
    action?: string;
    actionArgs: string[];
    entry: string;
    args: string[];
}

let args: Args = {
    binary: os.args[0],
    internalArgs: [],
    entry: 'repl',
    args: [],
    actionArgs: []
}

// simply parse deno-liked args
// (for example, `cno --internal=x run --run-args=1 main.js --user-args=y zzz`).
// you should override this by setArgs call.
let entryParsed = false;
let actionParsed = false;
for (let i = 1; i < os.args.length; i++) {
    const current = os.args[i];
    if (entryParsed) {
        args.args.push(current);
    } else if (actionParsed) {
        if (current[0] == '-') {
            args.actionArgs.push(current);
        } else {
            args.action = current;
            actionParsed = true;
        }
    } else {
        if (current[0] == '-') {
            args.args.push(current);
        } else {
            args.entry = current;
            entryParsed = true;
        }
    }
}

export default function setArgs(usrargs: Args) {
    args = usrargs;
}

export function getArgs(): Args {
    return args;
}

export function buildDenoArgs(): string[] { 
    return [...args.actionArgs, args.entry, ...args.args];
}

Reflect.set(os, '__cno_args', {
    set: setArgs,
    get: getArgs
});