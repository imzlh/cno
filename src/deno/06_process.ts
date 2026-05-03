import { assert } from "../utils/assert";
import { malloc } from "../utils/malloc";
import { wrapFsClassDec as wrap, wrapFSns } from "../utils/wrap";
import { toString } from "./02_fs";
import { useWritable } from "./05_net";

const os = import.meta.use('os');
const proc = import.meta.use('process');
const signal = import.meta.use('signals');
const text = import.meta.use('text');
const pty = import.meta.use('pty');
const engine = import.meta.use('engine');

const pipe = (type?: Deno.CommandOptions['stdout']): CModuleProcess.SpawnOptions<false>['stdout'] =>
    type == 'piped' ? 'pipe' : (type == 'null' ? 'ignore' : 'inherit');

class RStream extends ReadableStream<Uint8Array<ArrayBuffer>> implements Deno.SubprocessReadableStream {
    constructor(private pipe: CModuleProcess.Pipe) {
        super({
            async pull(controller) {
                try {
                    const buf = malloc(controller);
                    const n = await pipe.read(buf);
                    if (n === 0) {
                        controller.close();
                    } else {
                        controller.enqueue(buf.slice(0, n));
                    }
                } catch (e) {
                    controller.error(e);
                }
            }
        });
    }

    @wrap
    private async readAll() {
        const bufs = [] as Uint8Array[];
        const reader = this.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            bufs.push(value);
        }
        const retU8 = new Uint8Array(bufs.reduce((acc, cur) => acc + cur.length, 0));
        let offset = 0;
        for (const buf of bufs) {
            retU8.set(buf, offset);
            offset += buf.length;
        }
        return retU8;
    }

    async text(): Promise<string> {
        const buf = await this.readAll();
        return text ? new text.Decoder().decode(buf.buffer) : engine.decodeString(buf);
    }

    async json(): Promise<any> {
        return JSON.parse(await this.text());
    }

    async arrayBuffer(): Promise<ArrayBuffer> {
        const buf = await this.readAll();
        return buf.buffer;
    }

    bytes(): Promise<Uint8Array<ArrayBuffer>> {
        return this.readAll();
    }
}

class Process implements Deno.ChildProcess {
    private $stdin: WritableStream<Uint8Array>;
    private $stdout: RStream;
    private $stderr: RStream;

    pid: number;
    status: Promise<Deno.CommandStatus>;

    constructor(private $proc: CModuleProcess.ChildProcess, private $wait: Promise<CModuleProcess.ExitInfo>) {
        this.$stdin = useWritable($proc.stdin!);
        this.$stdout = new RStream($proc.stdout!);
        this.$stderr = new RStream($proc.stderr!);
        this.pid = $proc.pid;
        this.status = this.$wait.then(f => ({
            code: f.exit_status,
            success: f.exit_status === 0,
            signal: f.term_signal as any
        }));
    }

    @wrap
    output(): Promise<Deno.CommandOutput> {
        return this.$wait.then(async f => ({
            code: f.exit_status,
            // @ts-ignore
            signal: f.term_signal ? signal.signals[f.term_signal] : null,
            success: f.exit_status === 0,
            stderr: await this.$stderr.bytes(),
            stdout: await this.$stdout.bytes()
        }));
    }

    @wrap
    kill(signo?: Deno.Signal): void {
        assert(signo != 'SIGEMT', "Not implemented");
        // @ts-ignore
        this.$proc.kill(signo);
    }

    ref(): void {
        throw new Deno.errors.NotSupported();
    }

    unref(): void {
        throw new Deno.errors.NotSupported();
    }

    get stdin(): WritableStream<Uint8Array<ArrayBufferLike>> {
        return this.$stdin;
    }

    get stdout(): Deno.SubprocessReadableStream {
        return this.$stdout;
    }

    get stderr(): Deno.SubprocessReadableStream {
        return this.$stderr;
    }

    @wrap
    async [Symbol.asyncDispose]() {
        this.kill();
        await this.status;
    }

    @wrap
    async resize(cols: number, rows: number): Promise<void> {
        const stdin = this.$proc.stdin?.fileno;
        assert(stdin, "stdin is not piped");
        return this.$proc.resize(cols, rows);
    }
}

function spawn(path: string, args: string[], options?: Deno.CommandOptions): CModuleProcess.ChildProcess {
    return proc.spawn([path, ...args], {
        cwd: options?.cwd ? toString(options.cwd) : undefined,
        env: options?.env,
        stdin: pipe(options?.stdin) ?? 'inherit',
        stdout: pipe(options?.stdout) ?? 'inherit',
        stderr: pipe(options?.stderr) ?? 'inherit',
        detached: options?.detached,
        uid: options?.uid,
        gid: options?.gid
    })
}

class Command implements Deno.Command {
    private proc: CModuleProcess.ChildProcess; private detached: boolean;

    constructor(command: string | URL, options?: Deno.CommandOptions) {
        const path = toString(command);
        const args = options?.args ?? [];
        this.proc = spawn(path, args, options);
        this.detached = options?.detached ?? false;
    }

    @wrap
    async output(): Promise<Deno.CommandOutput> {
        assert(!this.detached, "Detached process cannot be waited");

        const stdo = this.proc.stdout ? new RStream(this.proc.stdout).bytes() : Promise.resolve(new Uint8Array(0));
        const stde = this.proc.stderr ? new RStream(this.proc.stderr).bytes() : Promise.resolve(new Uint8Array(0));
        const res = await this.proc.wait();
        return {
            code: res.exit_status,
            // @ts-ignore
            signal: res.term_signal ? signal.signals[res.term_signal] : null,
            success: res.exit_status === 0,
            stderr: await stde,
            stdout: await stdo
        };
    }

    @wrap
    outputSync(): Deno.CommandOutput {
        assert(!this.detached, "Detached process cannot be waited");

        // TODO: implement reading stdout/stderr data
        const res = this.proc.waitSync();
        return {
            code: res.exit_status,
            // @ts-ignore
            signal: res.term_signal ? signal.signals[res.term_signal] : null,
            success: res.exit_status === 0,
            stderr: new Uint8Array(0),
            stdout: new Uint8Array(0)
        };
    }

    @wrap
    spawn(): Deno.ChildProcess {
        if (this.detached)
            throw new TypeError("Detached process cannot be spawned");
        return new Process(this.proc, this.proc.wait());
    }
}

Object.assign(Deno, wrapFSns({
    kill(pid: number, signo?: number | Deno.Signal): void {
        assert(signo != 'SIGEMT' && signo != 'SIGIO' && signo != 'SIGUNUSED', "Not implemented");
        proc.kill(pid, signo);
    },

    umask(mask?: number): number {
        return 0;   // not implemented
    },

    // unstable, but useful
    spawn(command: string | URL, optOrArgs?: Deno.CommandOptions | string[], opt?: Deno.CommandOptions): Deno.ChildProcess {
        const option = Array.isArray(optOrArgs) ? opt : optOrArgs;
        const args = Array.isArray(optOrArgs) ? optOrArgs : option?.args ?? [];
        const process = spawn(toString(command), args, option);
        return new Process(process, process.wait());
    }
}));

// class constructor should NEVER being wrapped
Reflect.set(Deno, "Command", Command);