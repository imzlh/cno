// 04_stdio.ts — Deno.stdin/stdout/stderr facade over the shared stdio
// singletons. The Stream class and singletons now live in utils/stdio.ts.

import { stdin, stdout, stderr } from "../utils/stdio";

const os = import.meta.use('os');

export type { Stream } from "../utils/stdio";

type DenoStdioNamespace = {
    stdin: typeof Deno.stdin & { rid: number };
    stdout: typeof Deno.stdout & { rid: number };
    stderr: typeof Deno.stderr & { rid: number };
    consoleSize(): { rows: number; columns: number };
    isatty(fd: number): boolean;
};

const denoStdioNs: DenoStdioNamespace = {
    stdin: {
        rid: os.STDIN_FILENO,

        close(){
            stdin.close();
        },

        isTerminal() {
            return stdin.isTTY;
        },

        read(p: Uint8Array<ArrayBuffer>) {
            return stdin.read(p);
        },

        readSync(p: Uint8Array) {
            return stdin.readSync(p);
        },

        get readable() {
            return stdin.createReadStream();
        },

        setRaw(mode: boolean, options?: Deno.SetRawOptions) {
            stdin.setRaw(mode);
        },
    },

    stdout: {
        rid: os.STDOUT_FILENO,

        close() {
            stdout.close();
        },

        isTerminal() {
            return stdout.isTTY;
        },

        write(data: Uint8Array) {
            return stdout.write(data);
        },

        writeSync(data: Uint8Array) {
            return stdout.writeSync(data);
        },

        get writable() {
            return stdout.createWriteStream();
        }
    },
    stderr: {
        rid: os.STDERR_FILENO,

        close() {
            return stderr.close();
        },

        write(p: Uint8Array) {
            return stderr.write(p);
        },

        writeSync(p: Uint8Array) {
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
    },

    isatty(fd: number) {
        if (fd === os.STDIN_FILENO) return stdin.isTTY;
        if (fd === os.STDOUT_FILENO) return stdout.isTTY;
        if (fd === os.STDERR_FILENO) return stderr.isTTY;
        return false;
    }
};

Object.assign(Deno, denoStdioNs);

export { stdin, stdout, stderr };
