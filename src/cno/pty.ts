import { malloc } from "../utils/malloc";
import { osShell } from "../utils/platform";
import { wrapFSErr } from "../utils/wrap";

const process = import.meta.use('process');
const os = import.meta.use('os');
const error = import.meta.use('error');

function pipeToReadable(pipe: CModuleStreams.Pipe): ReadableStream<Uint8Array> {
    return new ReadableStream({
        pull: async (controller) => {
	            try {
	                const buf = malloc(controller);
	                const n = await pipe.read(buf);
	                if (n === null) {
	                    controller.close();
	                    return;
	                }
	                controller.enqueue(buf.subarray(0, n));
	            } catch (e) {
                controller.error(wrapFSErr(e));
            }
        }
    });
}

function pipeToWritable(pipe: CModuleStreams.Pipe): WritableStream<Uint8Array> {
    return new WritableStream({
        write: async (data) => {
            const n = await pipe.write(data);
            if (n === null) throw error.Error(error.errno.EOF);
        }
    });
}

class PtyProcess implements CNO.PtyPipe {
    #proc: CModuleProcess.ChildProcess<true>;
    #readable: ReadableStream<Uint8Array>;
    #writable: WritableStream<Uint8Array>;

    constructor(opts: CNO.OpenptyOptions) {
        if (opts.argv !== undefined && !Array.isArray(opts.argv)) {
            throw new TypeError('argv must be an array of strings');
        }
        if (opts.env !== undefined && (typeof opts.env !== 'object' || opts.env === null)) {
            throw new TypeError('env must be a Record<string, string>');
        }
        if (opts.cols !== undefined && (opts.cols < 1 || !Number.isInteger(opts.cols))) {
            throw new RangeError('cols must be a positive integer');
        }
        if (opts.rows !== undefined && (opts.rows < 1 || !Number.isInteger(opts.rows))) {
            throw new RangeError('rows must be a positive integer');
        }
        const spawnOpts: CModuleProcess.SpawnOptions<true> = {
            pty: true,
            cols: opts.cols,
            rows: opts.rows,
            cwd: opts.cwd,
            env: opts.env,
        };
        if (opts.argv && opts.argv.length > 0) {
            this.#proc = process.spawn(opts.argv, spawnOpts);
        } else {
            this.#proc = process.spawn([opts.name ?? osShell], spawnOpts);
        }
        if (!this.#proc.readable || !this.#proc.writable) throw new Error('pty process pipes were not created');
        this.#readable = pipeToReadable(this.#proc.readable);
        this.#writable = pipeToWritable(this.#proc.writable);
    }

    get pid(): number { return this.#proc.pid; }
    get readable(): ReadableStream<Uint8Array> { return this.#readable; }
    get writable(): WritableStream<Uint8Array> { return this.#writable; }

    kill(signal: CNO.Signal = 'SIGINT') { this.#proc.kill(signal); }
    resize(cols: number, rows: number) { this.#proc.resize(cols, rows); }
    getwinsize(): CNO.WinSize { return this.#proc.getwinsize; }
    wait(): Promise<CNO.ExitInfo> { return Promise.resolve(this.#proc.waitSync()).then(res => ({
        exitStatus: res.exit_status,
        termSignal: res.term_signal
    })); }
}

Reflect.set(CNO, 'openpty', async function (opts: CNO.OpenptyOptions): Promise<CNO.PtyPipe> {
    return new PtyProcess(opts);
});
