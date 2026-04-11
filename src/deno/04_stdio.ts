import { malloc } from "../utils/malloc";
import { wrapFsClassDec as wrap } from "../utils/wrap";
import { FSFile } from "./03_fopen";

const os = import.meta.use('os');
const pipe = import.meta.use('streams');
const fs = import.meta.use('asyncfs');
const syncfs = import.meta.use('fs');

type AnyStream = CModuleStreams.Pipe | CModuleStreams.TTY | Deno.FsFile;

const lockings: Record<number, boolean> = {
    [os.STDIN_FILENO]: false,
    [os.STDOUT_FILENO]: false,
    [os.STDERR_FILENO]: false,
};

function lock(fd: number) {
    if (lockings[fd]) throw new Error("File is already locked");
    lockings[fd] = true;
}

function unlock(fd: number) {
    lockings[fd] = false;
}

function tryLock(fd: number) {
    if (lockings[fd]) throw new Error("File is already locked");
}

export class Stream {
    protected type: 'pipe' | 'tty' | 'file';
    protected stream: AnyStream;
    protected fd: number;

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
        this.fd = fd;
    }

    @wrap
    async write(data: Uint8Array) {
        lock(this.fd);
        let w = this.stream.write(data);
        unlock(this.fd);
        return w;
    }

    @wrap
    async read(buf: Uint8Array): Promise<number | null> {
        lock(this.fd);
        const r = this.stream.read(buf);
        unlock(this.fd);
        return r;
    }

    @wrap
    readSync(buf: Uint8Array): number | null {
        if (this.type == 'file') {
            tryLock(this.fd);
            return (this.stream as FSFile).readSync(buf);
        } else {
            return syncfs.read(this.fd, buf);
        }
    }

    @wrap
    writeSync(data: Uint8Array): number {
        if (this.type == 'file') {
            tryLock(this.fd);
            return (this.stream as FSFile).writeSync(data);
        } else {
            // fixme: use other method to write sync
            return syncfs.write(this.fd, data);
        }
    }

    get size(){
        if (this.type != 'tty') throw new Error('Only TTY streams have a size');
        return (this.stream as CModuleStreams.TTY).getWinSize();
    }

    @wrap
    createReadStream(): ReadableStream {
        return new ReadableStream({
            pull: async ctrl => {
                try{
                    const buf = malloc(ctrl);
                    lock(this.fd);
                    const readed = await this.stream.read(buf);
                    if (!readed) ctrl.close();
                    else ctrl.enqueue(buf.slice(0, readed));
                }catch(e){
                    ctrl.error(e);
                } finally {
                    unlock(this.fd);
                }
            }
        });
    }

    @wrap
    createWriteStream(): WritableStream {
        return  new WritableStream({
            write: async (chunk, control) => {
                try {
                    lock(this.fd);
                    let written = 0;
                    while (written < chunk.length) {
                        const n = await this.write(chunk.subarray(written));
                        written += n;
                    }
                } catch (e) {
                    control.error(e);
                } finally {
                    unlock(this.fd);
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

    @wrap
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