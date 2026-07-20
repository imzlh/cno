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

class Stdin {
    #stream = stdin;
    #readable = this.#stream.createReadStream() as typeof Deno.stdin.readable;

    get rid() {
        return this.#stream.fd;
    }

    close() {
        if (!this.#stream.isClosed) this.#stream.close();
    }

    isTerminal() {
        return this.#stream.isTTY;
    }

    async read(p: Uint8Array<ArrayBuffer>) {
        if (p.length === 0) return 0;
        return await this.#stream.read(p);
    }

    readSync(p: Uint8Array) {
        if (p.length === 0) return 0;
        return this.#stream.readSync(p);
    }

    get readable() {
        return this.#readable;
    }

    setRaw(mode: boolean, options?: Deno.SetRawOptions) {
        this.#stream.setRaw(mode, options === undefined ? false : !!options.cbreak);
    }
}

class Stdout {
    #stream = stdout;
    #writable = this.#stream.createWriteStream() as typeof Deno.stdout.writable;

    get rid() {
        return this.#stream.fd;
    }

    close() {
        this.#stream.close();
    }

    isTerminal() {
        return this.#stream.isTTY;
    }

    write(data: Uint8Array) {
        return this.#stream.write(data);
    }

    writeSync(data: Uint8Array) {
        return this.#stream.writeSync(data);
    }

    get writable() {
        return this.#writable;
    }
}

class Stderr {
    #stream = stderr;
    #writable = this.#stream.createWriteStream() as typeof Deno.stderr.writable;

    get rid() {
        return this.#stream.fd;
    }

    close() {
        this.#stream.close();
    }

    isTerminal() {
        return this.#stream.isTTY;
    }

    write(data: Uint8Array) {
        return this.#stream.write(data);
    }

    writeSync(data: Uint8Array) {
        return this.#stream.writeSync(data);
    }

    get writable() {
        return this.#writable;
    }
}

const denoStdioNs: DenoStdioNamespace = {
    stdin: new Stdin(),
    stdout: new Stdout(),
    stderr: new Stderr(),

    consoleSize(){
        for (const stream of [stdin, stdout, stderr]) {
            if (!stream.isTTY) continue;
            const size = stream.size;
            return { rows: size.height, columns: size.width };
        }
        throw new Error(
            'Could not get console size: stdin, stdout, and stderr are not connected to a terminal'
        );
    },

    isatty(fd: number) {
        if (typeof fd !== 'number' && typeof fd !== 'bigint') {
            throw new TypeError('expected i32');
        }
        const descriptor = Number(fd) | 0;
        if (descriptor === os.STDIN_FILENO) return stdin.isTTY;
        if (descriptor === os.STDOUT_FILENO) return stdout.isTTY;
        if (descriptor === os.STDERR_FILENO) return stderr.isTTY;
        try { return os.guessHandle(descriptor) === 'tty'; }
        catch { return false; }
    }
};

Object.assign(Deno, denoStdioNs);

export { stdin, stdout, stderr };
