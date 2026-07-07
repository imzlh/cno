import * as assert from '../assert';

type DoneCallback = (error?: unknown) => void;
type TestBody = (t: TestContext, done?: DoneCallback) => unknown;
type TestOptions = {
    concurrency?: number | boolean;
    only?: boolean;
    signal?: AbortSignal;
    skip?: boolean | string;
    timeout?: number;
    todo?: boolean | string;
};
type DenoTestContext = {
    name: string;
    origin: string;
    parent?: DenoTestContext;
    step: (name: string, fn: (t: DenoTestContext) => void | Promise<void>) => Promise<boolean>;
};
type DenoTestDefinition = {
    name: string;
    fn: (t: DenoTestContext) => void | Promise<void>;
    ignore?: boolean;
    only?: boolean;
    signal?: AbortSignal;
    timeout?: number;
};
type MockCall = {
    arguments: unknown[];
    error?: unknown;
    result: unknown;
    stack: Error;
    target: object | undefined;
    this: unknown;
};
type MockedFunction = ((...args: unknown[]) => unknown) & { mock: MockFunctionContext };

class TestControl extends Error {
    constructor(readonly kind: 'skip' | 'todo') {
        super(kind);
    }
}

export class MockFunctionContext {
    calls: MockCall[] = [];

    constructor(private readonly restoreCallback?: () => void) {}

    callCount(): number {
        return this.calls.length;
    }

    resetCalls(): void {
        this.calls.length = 0;
    }

    restore(): void {
        this.restoreCallback?.();
    }
}

class MockTracker {
    readonly #mocks = new Set<MockFunctionContext>();
    readonly #restoreCallbacks = new Set<() => void>();

    fn(original?: (...args: unknown[]) => unknown, implementation?: (...args: unknown[]) => unknown, options?: { times?: number }): MockedFunction {
        let base = original;
        let impl = implementation;
        if (original && implementation === undefined) {
            impl = original;
            base = undefined;
        }
        const times = options?.times;
        let implCalls = 0;
        const ctx = new MockFunctionContext();
        const mocked = function (this: unknown, ...args: unknown[]): unknown {
            const useImpl = impl && (times === undefined || implCalls < times);
            const callTarget = useImpl ? impl : base;
            if (useImpl) implCalls++;
            try {
                const result = callTarget?.apply(this, args);
                ctx.calls.push({ arguments: args, result, stack: new Error(), target: callTarget, this: this });
                return result;
            } catch (error) {
                ctx.calls.push({ arguments: args, error, result: undefined, stack: new Error(), target: callTarget, this: this });
                throw error;
            }
        } as MockedFunction;
        Object.defineProperty(mocked, 'mock', { value: ctx, enumerable: true, configurable: true });
        this.#mocks.add(ctx);
        return mocked;
    }

    method(target: object, property: PropertyKey, implementation?: (...args: unknown[]) => unknown, options?: { times?: number }): MockedFunction {
        const current = Reflect.get(target, property);
        if (typeof current !== 'function') {
            throw new TypeError(`Cannot mock property '${String(property)}' because it is not a function`);
        }
        const desc = findPropertyDescriptor(target, property);
        const original = current as (...args: unknown[]) => unknown;
        let restored = false;
        const restore = () => {
            if (restored) return;
            restored = true;
            if (desc) Object.defineProperty(target, property, desc);
            else Reflect.deleteProperty(target, property);
        };
        const mocked = this.fn(original, implementation, options);
        Object.defineProperty(mocked.mock, 'restore', { value: restore, configurable: true });
        Reflect.set(target, property, mocked);
        this.#restoreCallbacks.add(restore);
        return mocked;
    }

    reset(): void {
        for (const ctx of this.#mocks) ctx.resetCalls();
    }

    restoreAll(): void {
        for (const restore of this.#restoreCallbacks) restore();
        this.#restoreCallbacks.clear();
        this.reset();
    }
}

export class TestContext {
    readonly assert = assert;

    constructor(readonly name: string, private readonly denoContext?: DenoTestContext) {}

    diagnostic(message: string): void {
        console.log(`DIAGNOSTIC: ${message}`);
    }

    skip(_message?: string): never {
        throw new TestControl('skip');
    }

    todo(_message?: string): never {
        throw new TestControl('todo');
    }

    async test(name: string, optionsOrFn?: TestOptions | TestBody, maybeFn?: TestBody): Promise<void> {
        const { options, fn } = parseArgs(name, optionsOrFn, maybeFn);
        if (options.skip || options.todo || !fn) return;
        if (!this.denoContext) {
            await runBody(name, fn);
            return;
        }
        const ok = await this.denoContext.step(name, async (stepContext) => {
            await runBody(name, fn, stepContext);
        });
        if (!ok) throw new Error(`subtest failed: ${name}`);
    }
}

export const mock = new MockTracker();

function findPropertyDescriptor(target: object, property: PropertyKey): PropertyDescriptor | undefined {
    let current: object | null = target;
    while (current) {
        const desc = Object.getOwnPropertyDescriptor(current, property);
        if (desc) return desc;
        current = Object.getPrototypeOf(current);
    }
    return undefined;
}

function denoTest(definition: DenoTestDefinition): void {
    const deno = Reflect.get(globalThis, 'Deno');
    const test = deno && typeof deno === 'object' ? Reflect.get(deno, 'test') : undefined;
    if (typeof test !== 'function') {
        throw new Error('node:test requires the cno test runner');
    }
    test(definition);
}

function parseArgs(name: string, optionsOrFn?: TestOptions | TestBody, maybeFn?: TestBody): { options: TestOptions; fn?: TestBody } {
    if (typeof optionsOrFn === 'function') return { options: {}, fn: optionsOrFn };
    return { options: optionsOrFn ?? {}, fn: maybeFn };
}

function donePromise(body: TestBody, context: TestContext): Promise<void> {
    return new Promise((resolve, reject) => {
        let called = false;
        const done: DoneCallback = (error?: unknown) => {
            if (called) {
                reject(new Error('done callback called multiple times'));
                return;
            }
            called = true;
            if (error) reject(error);
            else resolve();
        };
        try {
            const result = body(context, done);
            if (result && typeof result === 'object' && typeof Reflect.get(result, 'then') === 'function') {
                reject(new Error('callback style tests cannot return a Promise'));
            }
        } catch (error) {
            reject(error);
        }
    });
}

async function runBody(name: string, body: TestBody, denoContext?: DenoTestContext): Promise<void> {
    const context = new TestContext(name, denoContext);
    try {
        if (body.length >= 2) await donePromise(body, context);
        else await body(context);
    } catch (error) {
        if (error instanceof TestControl) return;
        throw error;
    }
}

function test(name: string, options: TestOptions, fn: TestBody): void;
function test(name: string, fn: TestBody): void;
function test(name: string, optionsOrFn?: TestOptions | TestBody, maybeFn?: TestBody): void {
    const { options, fn } = parseArgs(name, optionsOrFn, maybeFn);
    const definition: DenoTestDefinition = {
        name,
        ignore: !!options.skip || !!options.todo,
        only: options.only,
        signal: options.signal,
        timeout: options.timeout,
        fn: async (denoContext) => {
            if (!fn) return;
            await runBody(name, fn, denoContext);
        },
    };
    denoTest(definition);
}

const testObject = Object.assign(test, {
    mock,
    test,
    skip(name: string, optionsOrFn?: TestOptions | TestBody, maybeFn?: TestBody): void {
        const { options, fn } = parseArgs(name, optionsOrFn, maybeFn);
        test(name, { ...options, skip: true }, fn ?? (() => {}));
    },
    todo(name: string, optionsOrFn?: TestOptions | TestBody, maybeFn?: TestBody): void {
        const { options, fn } = parseArgs(name, optionsOrFn, maybeFn);
        test(name, { ...options, todo: true }, fn ?? (() => {}));
    },
    only(name: string, optionsOrFn?: TestOptions | TestBody, maybeFn?: TestBody): void {
        const { options, fn } = parseArgs(name, optionsOrFn, maybeFn);
        test(name, { ...options, only: true }, fn ?? (() => {}));
    },
});

export const describe = testObject;
export const it = testObject;
export const suite = testObject;
export { testObject as test };
export default testObject;
