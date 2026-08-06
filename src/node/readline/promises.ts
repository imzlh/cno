import {
    Interface as BaseInterface,
    clearLine,
    clearScreenDown,
    cursorTo,
    moveCursor,
    type ReadLineOptions,
} from './mod';

export type PromisesInterface = BaseInterface & {
    question(query: string, options?: { signal?: AbortSignal }): Promise<string>;
};

/** Swaps in the promise form of `question` that Node exposes on this entry. */
function promisifyQuestion(rl: PromisesInterface): PromisesInterface {
    const baseQuestion = BaseInterface.prototype.question.bind(rl);

    rl.question = (query: string, options?: { signal?: AbortSignal }): Promise<string> => {
        if (options?.signal?.aborted) {
            return Promise.reject(new Error('The operation was aborted'));
        }
        return new Promise<string>((resolve, reject) => {
            let settled = false;
            const onAbort = (): void => finish(() => reject(new Error('The operation was aborted')));
            const finish = (fn: () => void): void => {
                if (settled) return;
                settled = true;
                options?.signal?.removeEventListener('abort', onAbort);
                fn();
            };
            if (options?.signal) {
                options.signal.addEventListener('abort', onAbort, { once: true });
            }
            baseQuestion(query, (answer: string) => finish(() => resolve(answer)));
        });
    };

    return rl;
}

export function createInterface(options: ReadLineOptions | NodeJS.ReadableStream): PromisesInterface {
    return promisifyQuestion(new BaseInterface(options as ReadLineOptions) as PromisesInterface);
}

export const Interface = function Interface(this: unknown, options: ReadLineOptions | NodeJS.ReadableStream) {
    return createInterface(options);
} as unknown as {
    new (options: ReadLineOptions | NodeJS.ReadableStream): PromisesInterface;
    prototype: PromisesInterface;
};

Interface.prototype = BaseInterface.prototype as PromisesInterface;

/** Node's staged cursor helper: mutations buffer until commit(). */
export class Readline {
    private _stream: NodeJS.WritableStream;
    private _autoCommit: boolean;
    private _pending: string[] = [];

    constructor(stream: NodeJS.WritableStream, options?: { autoCommit?: boolean }) {
        this._stream = stream;
        this._autoCommit = options?.autoCommit ?? false;
    }

    private _stage(build: (sink: NodeJS.WritableStream) => void): this {
        if (this._autoCommit) {
            build(this._stream);
            return this;
        }
        build({ write: (chunk: string) => { this._pending.push(String(chunk)); return true; } } as NodeJS.WritableStream);
        return this;
    }

    clearLine(dir: -1 | 0 | 1): this {
        return this._stage(s => clearLine(s, dir));
    }

    clearScreenDown(): this {
        return this._stage(s => clearScreenDown(s));
    }

    cursorTo(x: number, y?: number): this {
        return this._stage(s => cursorTo(s, x, y));
    }

    moveCursor(dx: number, dy: number): this {
        return this._stage(s => moveCursor(s, dx, dy));
    }

    rollback(): this {
        this._pending = [];
        return this;
    }

    async commit(): Promise<void> {
        const data = this._pending.join('');
        this._pending = [];
        if (!data) return;
        await new Promise<void>((resolve, reject) => {
            try {
                this._stream.write(data, (err?: Error | null) => (err ? reject(err) : resolve()));
            } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
}
