import { toString } from "./02_fs";
import { Stream } from "./04_stdio";

const os = import.meta.use('os');
const proc = import.meta.use('process');
const signal = import.meta.use('signal');
const text = import.meta.use('text');

const pipe = (type?: Deno.CommandOptions['stdout']): CModuleProcess.SpawnOptions['stdout'] => 
    type == 'piped' ? 'pipe' : (type == 'null' ? 'ignore' : 'inherit');

class RStream extends ReadableStream<Uint8Array<ArrayBuffer>> implements Deno.SubprocessReadableStream {
    constructor(private pipe: CModuleProcess.Pipe) {
        super({
            pull: async ctrl => {
                try{
                    const buf = new Uint8Array(ctrl.desiredSize ?? 2048);
                    const readed = await pipe.read(buf);
                    if (!readed) ctrl.close();
                    else ctrl.enqueue(buf.slice(0, readed));
                }catch(e){
                    ctrl.error(e);
                }
            }
        });
    }

    private async readAll(){
        const bufs = [] as Uint8Array[];
        const reader = this.getReader();
        while(true){
            const { value, done } = await reader.read();
            if(done) break;
            bufs.push(value);
        }
        const retU8 = new Uint8Array(bufs.reduce((acc, cur) => acc + cur.length, 0));
        let offset = 0;
        for(const buf of bufs){
            retU8.set(buf, offset);
            offset += buf.length;
        }
        return retU8;
    }

    async text(): Promise<string> {
        const buf = await this.readAll();
        return new text.Decoder().decode(buf.buffer);
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
        this.$stdin = this.createWriteStream($proc.stdin!);
        this.$stdout = new RStream($proc.stdout!);
        this.$stderr = new RStream($proc.stderr!);
        this.pid = $proc.pid;
        this.status = this.$wait.then(f => ({ 
            code: f.exit_status, 
            success: f.exit_status === 0, 
            signal: f.term_signal as any
        }));
    }

    private createWriteStream(pipe: CModuleProcess.Pipe): WritableStream {
        return  new WritableStream({
            write: async (chunk, control) => {
                try {
                    let written = 0;
                    while (written < chunk.length) {
                        const n = await pipe.write(chunk.subarray(written));
                        written += n;
                    }
                } catch (e) {
                    control.error(e);
                }
            }
        });
    }

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

    kill(signo?: Deno.Signal): void {
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

    async [Symbol.asyncDispose](){
        this.kill();
        await this.status;
    }
}

class Command implements Deno.Command {
    private proc: CModuleProcess.ChildProcess;
    private detached: boolean;

    constructor(command: string | URL, options?: Deno.CommandOptions){
        const path = toString(command);
        // @ts-ignore object assign
        this.proc = proc.spawn(path, options?.args, {
            cwd: options?.cwd ? toString(options.cwd) : undefined,
            env: options?.env,
            stdin: pipe(options?.stdin) ?? 'inherit',
            stdout: pipe(options?.stdout) ?? 'inherit',
            stderr: pipe(options?.stderr) ?? 'inherit',
            detached: options?.detached,
            uid: options?.gid,
            gid: options?.gid
        });
        this.detached = options?.detached ?? false;
    }

    async output(): Promise<Deno.CommandOutput> {
        if (this.detached)
            throw new TypeError("Detached process cannot be waited");
        const stdo = new RStream(this.proc.stdout!).bytes();
        const stde = new RStream(this.proc.stderr!).bytes();
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

    outputSync(): Deno.CommandOutput {
        throw new Deno.errors.NotSupported();
    }

    spawn(): Deno.ChildProcess {
        if (this.detached)
            throw new TypeError("Detached process cannot be spawned");
        return new Process(this.proc, this.proc.wait());
    }
}

Object.assign(Deno, {
    Command,

    kill(pid: number, signo: Deno.Signal): void {
        proc.kill(pid, signo);
    },
} as Partial<typeof Deno>);