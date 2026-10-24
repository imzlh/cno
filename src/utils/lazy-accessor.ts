// A read before the module loads returns a forwarding stand-in and starts the
// load; writes to a pending accessor replace it with a data property.

export type LazyKind = 'fn' | 'ctor' | 'prototype' | 'instance' | 'props' | 'deferred';

/** A member of a `props` / `deferred` stand-in and how it forwards. */
export interface LazyMemberSpec {
    name: string;
    kind: Exclude<LazyKind, 'props' | 'instance'>;
}

export interface LazySpec {
    name: string;
    kind: LazyKind;
    /** `props` / `deferred`: the keys the stand-in object exposes. */
    members?: readonly LazyMemberSpec[];
    /** `prototype`: the final prototype object, known before the module loads. */
    finalPrototype?: object;
    /** Classes the loaders of other layers extend; see below. */
    extendsOf?: 'HttpServer';
}

export type LazyLoader = () => Promise<ReadonlyMap<string, unknown>>;

export type LazyGlobal = Record<string, unknown>;

/** Final values by name once the loader has resolved. */
const resolvedValues = new WeakMap<object, ReadonlyMap<string, unknown>>();

/** The in-flight (or settled) load installed by `defineLazy`, by target and name. */
const pendingLoads = new Map<object, Map<string, Promise<void>>>();

/**
 * Prototype stand-ins by name ("HttpServer"), so a class *load* that extends the
 * real one (`class DenoHttpServer extends CnoHttpServerImpl`) can keep working
 * while the module that defines it is pending: it extends the stand-in, and the
 * stand-in is pointed at the final prototype once the module loads.
 */
const sharedPrototypes = new Map<string, { proto: object; adopt(final: object): void }>();

/** Prototype object to extend for a lazily loaded class name (`undefined` when unknown). */
export function lazyPrototype(name: string): object | undefined {
    return sharedPrototypes.get(name)?.proto;
}

function sharedPrototype(name: string): { proto: object; adopt(final: object): void } {
    let shared = sharedPrototypes.get(name);
    if (shared === undefined) {
        const proto = Object.create(null) as object;
        let final: object | null = null;
        shared = {
            proto,
            adopt(value) {
                final ??= value;
                Object.setPrototypeOf(proto, final);
            },
        };
        sharedPrototypes.set(name, shared);
    }
    return shared;
}

function finalValue(owner: object, name: string): unknown {
    return resolvedValues.get(owner)?.get(name);
}

function forwardingFunction(owner: object, name: string): (...args: unknown[]) => unknown {
    const forward = function (this: unknown, ...args: unknown[]): unknown {
        const value = finalValue(owner, name);
        if (typeof value !== 'function') {
            throw new Error(`${name} is not available yet: its module is still loading`);
        }
        return Reflect.apply(value as (...a: unknown[]) => unknown, this, args);
    };
    Object.defineProperty(forward, 'name', { value: name });
    Object.defineProperty(forward, 'length', { value: 0 });
    return forward;
}

function forwardingClass(owner: object, name: string, proto: object | undefined): new (...args: never[]) => unknown {
    const Forwarding = class {
        constructor(...args: never[]) {
            const value = finalValue(owner, name);
            if (typeof value !== 'function') {
                throw new Error(`${name} is not available yet: its module is still loading`);
            }
            return Reflect.construct(value as new (...a: never[]) => object, args);
        }
    };
    Object.defineProperty(Forwarding, 'name', { value: name });
    if (proto !== undefined) Object.defineProperty(Forwarding, 'prototype', { value: proto });
    return Forwarding;
}

function standIn(owner: object, name: string, spec: LazySpec, load: LazyLoader, lazyLoads?: ReadonlySet<string>): unknown {
    switch (spec.kind) {
        case 'fn':
            return forwardingFunction(owner, name);
        case 'ctor':
            return forwardingClass(owner, name, undefined);
        case 'prototype': {
            if (spec.finalPrototype !== undefined) return forwardingClass(owner, name, spec.finalPrototype);
            const shared = sharedPrototype(name);
            adoptShared(shared, load, lazyLoads);
            return forwardingClass(owner, name, shared.proto);
        }
        case 'instance':
            return undefined;
        case 'props':
        case 'deferred': {
            const out: Record<string, unknown> = {};
            for (const member of spec.members ?? []) {
                out[member.name] = standIn(owner, member.name, { name: member.name, kind: member.kind }, load, lazyLoads);
            }
            return out;
        }
    }
}

/** Point a shared prototype at the real class once its module has loaded. */
function adoptShared(shared: { adopt(final: object): void }, load: LazyLoader, lazyLoads?: ReadonlySet<string>): void {
    if (lazyLoads === undefined) return;
    for (const [name, isLazy] of lazyLoads.entries()) {
        if (!isLazy) continue;
        void load().then((values) => {
            const value = values.get(name);
            if (typeof value === 'function') shared.adopt((value as { prototype: object }).prototype);
        }, () => { /* a failed load leaves the stand-in empty */ });
    }
}

/**
 * Copy a class's own static members onto the forwarding stand-in, so reads that
 * happen in the same turn as the first one (`WebSocket.CONNECTING` right after
 * `new WebSocket(...)` started the load) see the real values.
 */
function mirrorStatics(pending: unknown, value: unknown): void {
    if (typeof pending !== 'function' || typeof value !== 'function' || pending === value) return;
    for (const key of Reflect.ownKeys(value)) {
        if (key === 'length' || key === 'name' || key === 'prototype') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor !== undefined) Object.defineProperty(pending, key, { ...descriptor, configurable: true });
    }
}

function defineData(target: LazyGlobal, name: string, value: unknown): void {
    Object.defineProperty(target, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
    });
}

/**
 * Settles once `target[name]` holds its final value instead of a stand-in: the
 * in-flight load started by `defineLazy` resolves, an already loaded value
 * resolves at once, and a missing or reassigned name resolves immediately.
 */
export function whenLazy(target: object, name: string): Promise<void> {
    return pendingLoads.get(target)?.get(name) ?? Promise.resolve();
}

/**
 * Install accessors for `specs` on `target`, and start the load. The returned
 * promise resolves once every spec is replaced by its value. Accessors never
 * observe rejection: on failure they stay installed and the next read retries,
 * so an optional module that cannot load degrades to "not available yet".
 */
export function defineLazy(target: LazyGlobal, specs: readonly LazySpec[], load: LazyLoader, lazyLoads?: ReadonlySet<string>): Promise<void> {
    if (specs.length === 0) return Promise.resolve();
    let loading: Promise<void> | null = null;
    const settle = (values: ReadonlyMap<string, unknown>): void => {
        resolvedValues.set(target, values);
        for (const spec of specs) {
            const pending = (target as Record<string, unknown>)[spec.name];
            mirrorStatics(pending, values.get(spec.name));
            defineData(target, spec.name, values.get(spec.name));
        }
    };
    const start = (): Promise<void> => {
        loading ??= load().then(settle, () => {
            loading = null;
        });
        return loading;
    };

    let loads = pendingLoads.get(target);
    if (loads === undefined) {
        loads = new Map();
        pendingLoads.set(target, loads);
    }
    for (const spec of specs) {
        const value = standIn(target, spec.name, spec, load, lazyLoads);
        Object.defineProperty(target, spec.name, {
            get(): unknown {
                start();
                return value;
            },
            set(assigned: unknown): void {
                defineData(target, spec.name, assigned);
            },
            enumerable: true,
            configurable: true,
        });
        loads.set(spec.name, start());
    }

    // Callers that want the last value in the same turn await this; a load that is
    // already in flight is shared, so boot-side awaiters see the same evaluation.
    return start();
}
