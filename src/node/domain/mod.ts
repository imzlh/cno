import { EventEmitter } from '../events';

type AnyFn = (...args: unknown[]) => unknown;
type DomainEmitter = EventEmitter & { domain?: Domain | null };

// Active domain stack (Node: enter pushes, exit pops this domain and above).
const stack: Domain[] = [];

export let active: Domain | null = null;

function setActive(domain: Domain | null): void {
    active = domain;
    try {
        const proc = Reflect.get(globalThis, 'process') as { domain?: Domain | null } | undefined;
        if (proc && (typeof proc === 'object' || typeof proc === 'function')) {
            proc.domain = domain;
        }
    } catch {
        // process may be unavailable during early bootstrap
    }
}

export class Domain extends EventEmitter {
    members: DomainEmitter[] = [];
    #errorHandlers = new WeakMap<DomainEmitter, (error: unknown) => void>();

    enter(): void {
        stack.push(this);
        setActive(this);
    }

    exit(): void {
        const index = stack.lastIndexOf(this);
        if (index === -1) return;
        stack.length = index;
        setActive(stack[index - 1] ?? null);
    }

    add(emitter: DomainEmitter): void {
        if (!emitter || typeof emitter.on !== 'function') {
            throw new TypeError('The "emitter" argument must be an instance of EventEmitter');
        }
        if (this.#errorHandlers.has(emitter)) return;

        const onError = (error: unknown) => {
            this.emit('error', error);
        };
        this.#errorHandlers.set(emitter, onError);
        this.members.push(emitter);
        emitter.domain = this;
        emitter.on('error', onError);
    }

    remove(emitter: DomainEmitter): void {
        const onError = this.#errorHandlers.get(emitter);
        if (!onError) return;

        emitter.removeListener('error', onError);
        this.#errorHandlers.delete(emitter);
        const index = this.members.indexOf(emitter);
        if (index !== -1) this.members.splice(index, 1);
        if (emitter.domain === this) emitter.domain = null;
    }

    run<T>(fn: (...args: unknown[]) => T, ...args: unknown[]): T | undefined {
        this.enter();
        try {
            return fn(...args);
        } catch (error) {
            this.emit('error', error);
            return undefined;
        } finally {
            this.exit();
        }
    }

    bind<T extends AnyFn>(callback: T): (...args: Parameters<T>) => ReturnType<T> | undefined {
        if (typeof callback !== 'function') {
            throw new TypeError('The "callback" argument must be of type function');
        }
        const domain = this;
        return function bound(this: unknown, ...args: Parameters<T>): ReturnType<T> | undefined {
            return domain.run(() => callback.apply(this, args) as ReturnType<T>);
        };
    }

    intercept<T extends AnyFn>(callback: T): (error: unknown, ...args: Parameters<T>) => ReturnType<T> | undefined {
        if (typeof callback !== 'function') {
            throw new TypeError('The "callback" argument must be of type function');
        }
        const domain = this;
        return function intercepted(this: unknown, error: unknown, ...args: Parameters<T>): ReturnType<T> | undefined {
            if (error) {
                domain.emit('error', error);
                return undefined;
            }
            return domain.run(() => callback.apply(this, args) as ReturnType<T>);
        };
    }

    dispose(): void {
        this.destroy();
    }

    destroy(): void {
        // Drop this domain (and anything entered above it) from the stack.
        this.exit();
        for (const emitter of [...this.members]) this.remove(emitter);
        this.removeAllListeners();
    }
}

export function create(): Domain {
    return new Domain();
}

export const createDomain = create;
