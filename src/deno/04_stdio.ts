import { FSFile } from "./03_fopen";

const os = import.meta.use('os');
const pipe = import.meta.use('streams');
const fs = import.meta.use('asyncfs');
const syncfs = import.meta.use('fs');

type AnyStream = CModuleStreams.Pipe | CModuleStreams.TTY | Deno.FsFile;

export class Stream {
    protected type: 'pipe' | 'tty' | 'file';
    protected stream: AnyStream;

    constructor(fd: number, read = true) {
        const type = os.guessHandle(fd);
        switch (type) {
            // normal pipe
            case "udp":
            case "pipe":
            case "tcp":
            case "unknown":
                this.stream = new pipe.Pipe();
                this.stream.open(fd);
                this.type = 'pipe';
            break;
            case "tty":
                this.stream = new pipe.TTY(fd, read);
                this.type = 'tty';
            break;
            case "file":
                this.stream = new FSFile(fs.newStdioFile('stdio', fd));
                this.type = 'file';
            break;
        }
    }

    write(data: Uint8Array) {
        return this.stream.write(data);
    }

    read(buf: Uint8Array): Promise<number | null> {
        return this.stream.read(buf);
    }

    readSync(buf: Uint8Array): number | null {
        if (this.type == 'file') {
            return (this.stream as FSFile).readSync(buf);
        } else {
            // fixme: use other method to read sync
            const fno = (this.stream as CModuleStreams.Pipe | CModuleStreams.TTY).fileno();
            return syncfs.read(fno, buf, 0, 0);
        }
    }

    writeSync(data: Uint8Array): number {
        if (this.type == 'file') {
            return (this.stream as FSFile).writeSync(data);
        } else {
            // fixme: use other method to write sync
            const fno = (this.stream as CModuleStreams.Pipe | CModuleStreams.TTY).fileno();
            return syncfs.write(fno, data, 0, 0);
        }
    }

    get size(){
        if (this.type != 'tty') throw new Error('Only TTY streams have a size');
        return (this.stream as CModuleStreams.TTY).getWinSize();
    }

    createReadStream(): ReadableStream {
        return new ReadableStream({
            pull: async ctrl => {
                try{
                    const buf = new Uint8Array(ctrl.desiredSize ?? 2048);
                    const readed = await this.stream.read(buf);
                    if (!readed) ctrl.close();
                    else ctrl.enqueue(buf.slice(0, readed));
                }catch(e){
                    ctrl.error(e);
                }
            }
        });
    }

    createWriteStream(): WritableStream {
        return  new WritableStream({
            write: async (chunk, control) => {
                try {
                    let written = 0;
                    while (written < chunk.length) {
                        const n = await this.write(chunk.subarray(written));
                        written += n;
                    }
                } catch (e) {
                    control.error(e);
                }
            }
        });
    }

    close() {
        this.stream.close();
    }

    get isTTY(){
        return this.type == 'tty';
    }

    setRaw(mode: boolean) {
        if (this.type != 'tty') throw new Error('Only TTY streams can be set raw');
        (this.stream as CModuleStreams.TTY).setMode(
            mode ? pipe.TTY_MODE_RAW : pipe.TTY_MODE_NORMAL
        )
    }
}

const stdin = new Stream(os.STDIN_FILENO, true);
const stdout = new Stream(os.STDOUT_FILENO, false);
const stderr = new Stream(os.STDERR_FILENO, false);

Object.assign(Deno, {
    stdin: {
        close(){
            stdin.close();
        },

        isTerminal() {
            return stdin.isTTY;
        },

        read(p) {
            return stdin.read(p);
        },

        readSync(p) {
            return stdin.readSync(p);
        },

        readable: stdin.createReadStream(),

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

        writable: stdout.createWriteStream()
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

        writable: stderr.createWriteStream()
    },

    consoleSize(){
        const sz = stdout.size;
        return {
            rows: sz.width,
            columns: sz.height
        };
    }
} as Partial<typeof Deno>);