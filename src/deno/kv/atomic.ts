/**
 * Deno KV Atomic Operation Implementation
 */

import {
    AtomicCheck,
    KvCommitResult,
    KvCommitError,
    type KvQueueEntry,
    prepareQueueEntry,
    serializeKey,
    serializeValue,
    generateVersionstamp,
    resolveCommitVersionstampKey,
    validateExpireIn,
    validateKey,
    validateValue,
    type RawKey,
    type AtomicDbOperation,
    OP,
} from './types';
import { KvDatabase } from './db';
import { DENO_CUSTOM_INSPECT, KvU64, isKvU64 } from './u64';

const console = import.meta.use('console');

type AtomicOp =
    | { type: OP.CHECK; key: Deno.KvKey; versionstamp: string | null }
    | { type: OP.SET; key: Deno.KvKey; value: unknown; expireIn?: number }
    | { type: OP.DELETE; key: Deno.KvKey }
    | { type: OP.SUM | OP.MAX | OP.MIN; key: Deno.KvKey; operand: bigint }
    | { type: OP.ENQUEUE; key: Deno.KvKey; value: unknown; delay: number; queueEntry: KvQueueEntry };

interface AtomicHooks {
    notify?: (key: Deno.KvKey) => void;
    deliverQueue?: (entry: KvQueueEntry, rawQueueKey: RawKey) => void;
}

export class AtomicOperation implements Deno.AtomicOperation {
    private db: KvDatabase;
    private hooks?: AtomicHooks;
    private ops: AtomicOp[] = [];
    private committed = false;
    private maxChecks = 100;
    private maxOps = 1000;

    constructor(db: KvDatabase, hooks?: AtomicHooks) {
        this.db = db;
        this.hooks = hooks;
    }

    private assertOpen(): void {
        if (this.committed) {
            throw new Error('Atomic operation already committed');
        }
    }

    private countChecks(): number {
        return this.ops.filter(op => op.type === OP.CHECK).length;
    }

    private countMutations(): number {
        return this.ops.filter(op => op.type !== OP.CHECK).length;
    }

    private pushMutation(op: AtomicOp): void {
        if (this.countMutations() >= this.maxOps) {
            throw new TypeError(`Too many mutations (max ${this.maxOps})`);
        }
        this.ops.push(op);
    }

    private validateCheck(check: AtomicCheck): void {
        validateKey(check.key);
        if (check.versionstamp !== null && typeof check.versionstamp !== 'string') {
            throw new TypeError('versionstamp must be a string or null');
        }
    }

    private readU64Operand(type: OP.SUM | OP.MAX | OP.MIN, value: unknown): bigint {
        if (!isKvU64(value)) {
            throw new TypeError(`Failed to perform '${OP[type].toLowerCase()}' mutation on a non-U64 operand`);
        }
        return value.value;
    }

    check(...checks: AtomicCheck[]): this {
        this.assertOpen();
        
        if (this.countChecks() + checks.length > this.maxChecks) {
            throw new TypeError(`Too many checks (max ${this.maxChecks})`);
        }

        for (const check of checks) {
            this.validateCheck(check);
            this.ops.push({
                type: OP.CHECK,
                key: check.key,
                versionstamp: check.versionstamp,
            });
        }
        return this;
    }

    mutate(...mutations: Deno.KvMutation[]): this {
        this.assertOpen();

        for (const mutation of mutations) {
            switch (mutation.type) {
                case 'set':
                    validateKey(mutation.key, { allowCommitVersionstamp: true });
                    validateValue(mutation.value);
                    validateExpireIn(mutation.expireIn);
                    this.pushMutation({
                        type: OP.SET,
                        key: mutation.key,
                        value: mutation.value,
                        expireIn: mutation.expireIn,
                    });
                    break;
                case 'delete':
                    validateKey(mutation.key);
                    if ('value' in mutation) throw new TypeError("delete mutation cannot have a value");
                    this.pushMutation({
                        type: OP.DELETE,
                        key: mutation.key,
                    });
                    break;
                case 'sum':
                    validateKey(mutation.key);
                    this.pushMutation({
                        type: OP.SUM,
                        key: mutation.key,
                        operand: this.readU64Operand(OP.SUM, mutation.value),
                    });
                    break;
                case 'max':
                    validateKey(mutation.key);
                    this.pushMutation({
                        type: OP.MAX,
                        key: mutation.key,
                        operand: this.readU64Operand(OP.MAX, mutation.value),
                    });
                    break;
                case 'min':
                    validateKey(mutation.key);
                    this.pushMutation({
                        type: OP.MIN,
                        key: mutation.key,
                        operand: this.readU64Operand(OP.MIN, mutation.value),
                    });
                    break;
                default:
                    throw new TypeError(`Unknown mutation type: ${String(Reflect.get(mutation, 'type'))}`);
            }
        }
        return this;
    }

    set(key: Deno.KvKey, value: unknown, options?: { expireIn?: number }): this {
        this.assertOpen();

        validateKey(key, { allowCommitVersionstamp: true });
        validateValue(value);
        validateExpireIn(options?.expireIn);

        this.pushMutation({
            type: OP.SET,
            key,
            value,
            expireIn: options?.expireIn,
        });
        return this;
    }

    delete(key: Deno.KvKey): this {
        this.assertOpen();
        validateKey(key);

        this.pushMutation({
            type: OP.DELETE,
            key,
        });
        return this;
    }

    sum(key: Deno.KvKey, n: bigint): this {
        this.assertOpen();
        validateKey(key);
        const value = new KvU64(n);

        this.pushMutation({
            type: OP.SUM,
            key,
            operand: value.value,
        });
        return this;
    }

    max(key: Deno.KvKey, n: bigint): this {
        this.assertOpen();
        validateKey(key);
        const value = new KvU64(n);

        this.pushMutation({
            type: OP.MAX,
            key,
            operand: value.value,
        });
        return this;
    }

    min(key: Deno.KvKey, n: bigint): this {
        this.assertOpen();
        validateKey(key);
        const value = new KvU64(n);

        this.pushMutation({
            type: OP.MIN,
            key,
            operand: value.value,
        });
        return this;
    }

    enqueue(
        value: unknown,
        options?: {
            delay?: number;
            keysIfUndelivered?: Deno.KvKey[];
            backoffSchedule?: number[];
        }
    ): this {
        this.assertOpen();

        validateValue(value);
        const prepared = prepareQueueEntry(value, options);

        this.pushMutation({
            type: OP.ENQUEUE,
            key: prepared.key,
            value: prepared.entry,
            delay: prepared.delay,
            queueEntry: prepared.entry,
        });
        return this;
    }

    then<T1 = KvCommitResult | KvCommitError, T2 = never>(
        onfulfilled?: ((value: KvCommitResult | KvCommitError) => T1 | PromiseLike<T1>) | null,
        onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null
    ): Promise<T1 | T2> {
        return this.commit().then(onfulfilled, onrejected);
    }

    catch<TResult = never>(
        onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
    ): Promise<KvCommitResult | KvCommitError | TResult> {
        return this.commit().catch(onrejected);
    }

    finally(onfinally?: (() => void) | null): Promise<KvCommitResult | KvCommitError> {
        return this.commit().finally(onfinally);
    }

    [Symbol.toStringTag]: string = 'AtomicOperation';

    [DENO_CUSTOM_INSPECT](): string {
        if (this.ops.length === 0) return 'AtomicOperation (empty)';

        const inspect = (value: unknown): string => {
            if (isKvU64(value)) return value[DENO_CUSTOM_INSPECT]();
            if (typeof value === 'string') return JSON.stringify(value);
            if (Array.isArray(value)) return `[ ${value.map(inspect).join(', ')} ]`;
            return console.inspect(value, { colors: false, depth: 10 });
        };

        const lines = ['AtomicOperation'];
        for (const op of this.ops) {
            switch (op.type) {
                case OP.CHECK:
                    lines.push(`  check({ key: ${inspect(op.key)}, versionstamp: ${inspect(op.versionstamp ?? null)} })`);
                    break;
                case OP.SET:
                    if (op.expireIn === undefined) {
                        lines.push(`  set(${inspect(op.key)}, ${inspect(op.value)})`);
                    } else {
                        lines.push(`  set(${inspect(op.key)}, ${inspect(op.value)}, { expireIn: ${op.expireIn} })`);
                    }
                    break;
                case OP.DELETE:
                    lines.push(`  delete(${inspect(op.key)})`);
                    break;
                case OP.SUM:
                case OP.MAX:
                case OP.MIN:
                    lines.push(`  ${OP[op.type].toLowerCase()}(${inspect(op.key)}, ${inspect(new KvU64(op.operand))})`);
                    break;
                case OP.ENQUEUE: {
                    const options: Record<string, unknown> = {};
                    if (op.delay) options.delay = op.delay;
                    if (op.queueEntry?.undeliveredKeys) options.keysIfUndelivered = op.queueEntry.undeliveredKeys;
                    if (op.queueEntry?.backoffSchedule) options.backoffSchedule = op.queueEntry.backoffSchedule;
                    const suffix = Object.keys(options).length ? `, ${inspect(options)}` : '';
                    lines.push(`  enqueue(${inspect(op.queueEntry?.data ?? op.value)}${suffix})`);
                    break;
                }
            }
        }
        return lines.join('\n');
    }

    commit(): Promise<KvCommitResult | KvCommitError> {
        this.assertOpen();
        this.committed = true;

        if (this.ops.length === 0) {
            return Promise.resolve({
                ok: true,
                versionstamp: '00000000000000000000',
            });
        }

        const mutationVersionstamp = this.countMutations() > 0 ? generateVersionstamp() : undefined;
        try {
            const dbOps: AtomicDbOperation[] = this.ops.map(op => {
                const key = op.type === OP.SET && mutationVersionstamp
                    ? resolveCommitVersionstampKey(op.key, mutationVersionstamp)
                    : op.key;
                const rawKey = serializeKey(key);

                switch (op.type) {
                    case OP.CHECK:
                        if (typeof op.versionstamp === 'string' && !/^[0-9a-f]{20}$/.test(op.versionstamp)) {
                            throw new TypeError('Invalid versionstamp');
                        }
                        return {
                            type: 'check' as const,
                            key: rawKey,
                            versionstamp: op.versionstamp ?? null,
                        };
                    case OP.SET:
                        return {
                            type: 'set' as const,
                            key: rawKey,
                            value: serializeValue(op.value),
                            expireIn: op.expireIn,
                        };
                    case OP.DELETE:
                        return {
                            type: 'delete' as const,
                            key: rawKey,
                        };
                    case OP.SUM:
                    case OP.MAX:
                    case OP.MIN:
                        return {
                            type: OP[op.type].toLowerCase() as 'sum' | 'max' | 'min',
                            key: rawKey,
                            operand: op.operand,
                        };
                    case OP.ENQUEUE:
                        return {
                            type: 'set' as const,
                            key: rawKey,
                            value: serializeValue(op.value),
                            expireIn: (op.delay ?? 0) + 86400000,
                        };
                }
            });

            const result = this.db.atomic(dbOps, mutationVersionstamp);
            
            if (result.success) {
                for (const op of this.ops) {
                    if (op.type === OP.CHECK) continue;
                    const key = op.type === OP.SET && mutationVersionstamp
                        ? resolveCommitVersionstampKey(op.key, mutationVersionstamp)
                        : op.key;
                    const rawKey = serializeKey(key);
                    if (op.type === OP.ENQUEUE) {
                        if (op.delay === 0 && op.queueEntry) {
                            this.hooks?.deliverQueue?.(op.queueEntry, rawKey);
                        }
                    } else {
                        this.hooks?.notify?.(key);
                    }
                }
                return Promise.resolve({
                    ok: true,
                    versionstamp: result.versionstamp ?? mutationVersionstamp ?? '00000000000000000000',
                });
            } else {
                return Promise.resolve({ ok: false });
            }
        } catch (err) {
            return Promise.reject(err);
        }
    }
}
