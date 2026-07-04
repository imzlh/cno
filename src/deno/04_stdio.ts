// 04_stdio.ts — Deno.stdin/stdout/stderr facade over the shared stdio
// singletons. The Stream class and singletons now live in utils/stdio.ts.

import { stdin, stdout, stderr } from "../utils/stdio";

export type { Stream } from "../utils/stdio";

Object.assign(Deno, {
    stdin: {
        close(){
            stdin.close();
        },

        isTerminal() {
            return stdin.isTTY;
        },

        read(p) {
            return stdin.read(p as Uint8Array<ArrayBuffer>);
        },

        readSync(p) {
            return stdin.readSync(p);
        },

        get readable() {
            return stdin.createReadStream();
        },

        setRaw(mode, options) {
            stdin.setRaw(mode);
        },
    },

    stdout: {
        close() {
            stdout.close();
        },

        isTerminal() {
            return stdout.isTTY;
        },

        write(data) {
            return stdout.write(data);
        },

        writeSync(data) {
            return stdout.writeSync(data);
        },

        get writable() {
            return stdout.createWriteStream();
        }
    },
    stderr: {
        close() {
            return stderr.close();
        },

        write(p) {
            return stderr.write(p);
        },

        writeSync(p) {
            return stderr.writeSync(p);
        },

        isTerminal() {
            return stderr.isTTY;
        },

        get writable() {
            return stderr.createWriteStream();
        }
    },

    consoleSize(){
        const sz = stdout.size;
        return {
            rows: sz.height,
            columns: sz.width
        };
    }
} as Partial<typeof Deno>);

export { stdin, stdout, stderr };
