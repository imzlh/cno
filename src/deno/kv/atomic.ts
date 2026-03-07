/**
 * Deno KV Atomic Operation Implementation
 */

import {
    AtomicCheck,
    KvCommitResult,
    KvCommitError,
    serializeKey,
    serializeValue,
    validateValue,
} from './types';
import { KvDatabase } from './db';

interface AtomicOp {
    type: 'check' | 'set' | 'delete' | 'sum' | 'max' | 'min' | 'enqueue';
    key: Deno.KvKey;
    versionstamp?: string | null;
    value?: unknown;
    expireIn?: number;
    operand?: bigint;
    delay?: number;
    keysIfUndelivered?: Deno.KvKey[];
    backoffSchedule?: number[];
}

export class AtomicOperation implements Deno.AtomicOperation {
    private db: KvDatabase;
    private ops: AtomicOp[] = [];
    private committed = false;
    private maxChecks = 10;
    private maxOps = 1000;

    constructor(db: KvDatabase) {
        this.db = db;
    }

    check(...checks: AtomicCheck[]): this {
        if (this.committed) {
            throw new Error('Atomic operation already committed');
        }
        
        if (checks.length > this.maxChecks) {
            throw new TypeError(`Too many checks (max ${this.maxChecks})`);
        }

        for (const check of checks) {
            this.ops.push({
                type: 'check',
                key: check.key,
                versionstamp: check.versionstamp,
            });
        }
        return this;
    }

    mutate(...mutations: Deno.KvMutation[]): this {
        if (this.committed) {
            throw new Error('Atomic operation already committed');
        }

        for (const mutation of mutations) {
            switch (mutation.type) {
                case 'set':
                    validateValue(mutation.value);
                    this.ops.push({
                        type: 'set',
                        key: mutation.key,
                        value: mutation.value,
                        expireIn: mutation.expireIn,
                    });
                    break;
                case 'delete':
                    this.ops.push({
                        type: 'delete',
                        key: mutation.key,
                    });
                    break;
                case 'sum':
                    this.ops.push({
                        type: 'sum',
                        key: mutation.key,
                        operand: mutation.value.value,
                    });
                    break;
                case 'max':
                    this.ops.push({
                        type: 'max',
                        key: mutation.key,
                        operand: mutation.value.value,
                    });
                    break;
                case 'min':
                    this.ops.push({
                        type: 'min',
                        key: mutation.key,
                        operand: mutation.value.value,
                    });
                    break;
            }
        }
        return this;
    }

    set(key: Deno.KvKey, value: unknown, options?: { expireIn?: number }): this {
        if (this.committed) {
            throw new Error('Atomic operation already committed');
        }

        validateValue(value);
        
        if (this.ops.length >= this.maxOps) {
            throw new TypeError(`Too many operations (max ${this.maxOps})`);
        }

        this.ops.push({
            type: 'set',
            key,
            value,
            expireIn: options?.expireIn,
        });
        return this;
    }

    delete(key: Deno.KvKey): this {
        if (this.committed) {
            throw new Error('Atomic operation already committed');
        }
        
        if (this.ops.length >= this.maxOps) {
            throw new TypeError(`Too many operations (max ${this.maxOps})`);
        }

        this.ops.push({
            type: 'delete',
            key,
        });
        return this;
    }

    sum(key: Deno.KvKey, n: bigint): this {
        if (this.committed) {
            throw new Error('Atomic operation already committed');
        }
        
        if (this.ops.length >= this.maxOps) {
            throw new TypeError(`Too many operations (max ${this.maxOps})`);
        }

        this.ops.push({
            type: 'sum',
            key,
            operand: n,
        });
        return this;
    }

    max(key: Deno.KvKey, n: bigint): this {
        if (this.committed) {
            throw new Error('Atomic operation already committed');
        }
        
        if (this.ops.length >= this.maxOps) {
            throw new TypeError(`Too many operations (max ${this.maxOps})`);
        }

        this.ops.push({
            type: 'max',
            key,
            operand: n,
        });
        return this;
    }

    min(key: Deno.KvKey, n: bigint): this {
        if (this.committed) {
            throw new Error('Atomic operation already committed');
        }
        
        if (this.ops.length >= this.maxOps) {
            throw new TypeError(`Too many operations (max ${this.maxOps})`);
        }

        this.ops.push({
            type: 'min',
            key,
            operand: n,
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
        if (this.committed) {
            throw new Error('Atomic operation already committed');
        }

        validateValue(value);
        
        if (this.ops.length >= this.maxOps) {
            throw new TypeError(`Too many operations (max ${this.maxOps})`);
        }

        this.ops.push({
            type: 'enqueue',
            key: [],
            value,
            delay: options?.delay,
            keysIfUndelivered: options?.keysIfUndelivered,
            backoffSchedule: options?.backoffSchedule,
        });
        return this;
    }

    then<T1 = KvCommitResult | KvCommitError, T2 = never>(
        onfulfilled?: ((value: KvCommitResult | KvCommitError) => T1 | PromiseLike<T1>) | null,
        onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null
    ): Promise<T1 | T2> {
        return this.commit().then(onfulfilled, onrejected);
    }

    catch<TResult = never>(
        onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
    ): Promise<KvCommitResult | KvCommitError | TResult> {
        return this.commit().catch(onrejected);
    }

    finally(onfinally?: (() => void) | null): Promise<KvCommitResult | KvCommitError> {
        return this.commit().finally(onfinally);
    }

    [Symbol.toStringTag]: string = 'AtomicOperation';

    commit(): Promise<KvCommitResult | KvCommitError> {
        if (this.committed) {
            throw new Error('Atomic operation already committed');
        }
        this.committed = true;

        if (this.ops.length === 0) {
            return Promise.resolve({
                ok: true,
                versionstamp: '00000000000000000000',
            });
        }

        const dbOps = this.ops.map(op => {
            const rawKey = serializeKey(op.key);

            switch (op.type) {
                case 'check':
                    return {
                        type: 'check' as const,
                        key: rawKey,
                        versionstamp: op.versionstamp ?? null,
                    };
                case 'set':
                    return {
                        type: 'set' as const,
                        key: rawKey,
                        value: serializeValue(op.value),
                        expireIn: op.expireIn,
                    };
                case 'delete':
                    return {
                        type: 'delete' as const,
                        key: rawKey,
                    };
                case 'sum':
                case 'max':
                case 'min':
                    return {
                        type: op.type as 'sum' | 'max' | 'min',
                        key: rawKey,
                        operand: op.operand,
                    };
                case 'enqueue':
                    return {
                        type: 'set' as const,
                        key: rawKey,
                        value: serializeValue(op.value),
                        expireIn: op.delay,
                    };
            }
        });

        try {
            const result = this.db.atomic(dbOps);
            
            if (result.success) {
                return Promise.resolve({
                    ok: true,
                    versionstamp: result.versionstamp!,
                });
            } else {
                return Promise.resolve({ ok: false });
            }
        } catch (err) {
            return Promise.reject(err);
        }
    }
}
