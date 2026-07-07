import { EventEmitter } from '../events';

type AnyFn = (...args: unknown[]) => unknown;
type DomainEmitter = EventEmitter & { domain?: Domain | null };

export class Domain extends EventEmitter {
    members: DomainEmitter[] = [];
    #errorHandlers = new WeakMap<DomainEmitter, (error: unknown) => void>();

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
        try {
            return fn(...args);
        } catch (error) {
            this.emit('error', error);
            return undefined;
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
        for (const emitter of [...this.members]) this.remove(emitter);
        this.removeAllListeners();
    }
}

export function create(): Domain {
    return new Domain();
}

export const createDomain = create;
export const active: Domain | null = null;
