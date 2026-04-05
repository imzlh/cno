import assert from "node:assert";
import { parseArgs } from "jsr:@std/cli/parse-args";

export async function runServe(...args: string[]) {
    const arg = parseArgs(args, {
        string: ["port", "host"],
        boolean: ["help"],
        stopEarly: true
    });
    assert(arg._.length > 0, "At least one file is required");
    const file = arg._[0];
    Reflect.set(Deno, "args", arg._.slice(1));
    const exports = (await import(file as string)).default as Deno.ServeDefaultExport;
    if (!exports.fetch) {
        throw new Error(`File ${file} does not export fetch function`);
    }

    Deno.serve({
        port: parseInt(arg.port ?? "8080"),
        hostname: arg.host ?? "localhost",
        onListen: exports.onListen
    }, exports.fetch);
}