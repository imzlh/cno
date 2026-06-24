const os = import.meta.use('os');

// All process arguments (binary included)
export const all_args: string[] = os.args;

// Deno.args — settable so the CLI can inject the correct value after parsing.
// Initial value: everything after the binary (best-effort before CLI parsing).
let _denoArgs: string[] = all_args.slice(1);
export function getDenoArgs(): string[] { return _denoArgs; }
export function setDenoArgs(a: string[]): void { _denoArgs = a; }