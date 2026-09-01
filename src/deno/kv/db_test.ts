import { KvDatabase } from './db';

const sqlite3 = import.meta.use('sqlite3');

type Handle = CModuleSQLite3.Sqlite3Handle;
type Statement = CModuleSQLite3.Sqlite3Stmt;

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
    if (!Object.is(actual, expected)) {
        throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

interface ResourceCounters {
    opens: number;
    closes: number;
    prepares: number;
    finalizes: number;
}

function installSqliteMock(failExecAt?: number): {
    counters: ResourceCounters;
    restore(): void;
} {
    const counters: ResourceCounters = { opens: 0, closes: 0, prepares: 0, finalizes: 0 };
    const originalOpen = sqlite3.open;
    let execCount = 0;

    sqlite3.open = (() => {
        counters.opens++;
        const statements = new Set<Statement>();
        const handle = {
            exec(): void {
                execCount++;
                if (failExecAt === execCount) throw new Error(`injected exec failure ${execCount}`);
            },
            prepare(): Statement {
                counters.prepares++;
                let finalized = false;
                const statement = {
                    all(): CModuleSQLite3.SqliteRow[] {
                        return [];
                    },
                    run(): void {},
                    finalize(): void {
                        if (finalized) return;
                        finalized = true;
                        counters.finalizes++;
                        statements.delete(statement as Statement);
                    }
                } as Statement;
                statements.add(statement);
                return statement;
            },
            changes(): number {
                return 0;
            },
            close(): void {
                counters.closes++;
                for (const statement of [...statements]) statement.finalize();
            }
        } as Handle;
        return handle;
    }) as typeof sqlite3.open;

    return {
        counters,
        restore(): void {
            sqlite3.open = originalOpen;
        }
    };
}

for (const failExecAt of [1, 2, 3, 4, 5]) {
    Deno.test(`KvDatabase.open rolls back resources after exec stage ${failExecAt} fails`, async () => {
        const mock = installSqliteMock(failExecAt);
        const db = new KvDatabase(':memory:');
        try {
            let rejected = false;
            try {
                await db.open();
            } catch {
                rejected = true;
            }
            assert(rejected, 'open should reject');
            assertEquals(mock.counters.opens, 1, 'one SQLite handle should be created');
            assertEquals(mock.counters.closes, 1, 'failed SQLite handle should be closed');
            assertEquals(mock.counters.finalizes, mock.counters.prepares, 'all statements should be finalized');
            db.close();
            assertEquals(mock.counters.closes, 1, 'close should remain idempotent after rollback');
        } finally {
            db.close();
            mock.restore();
        }
    });
}

Deno.test('KvDatabase.open can retry after initialization failure', async () => {
    const failing = installSqliteMock(1);
    const db = new KvDatabase(':memory:');
    try {
        try {
            await db.open();
        } catch {
            // Expected injected failure.
        }
    } finally {
        failing.restore();
    }

    const succeeding = installSqliteMock();
    try {
        await db.open();
        assertEquals(succeeding.counters.opens, 1, 'retry should create one fresh handle');
        db.close();
        assertEquals(succeeding.counters.closes, 1, 'retry handle should close');
        assertEquals(succeeding.counters.finalizes, succeeding.counters.prepares, 'retry statements should finalize');
    } finally {
        db.close();
        succeeding.restore();
    }
});

Deno.test('concurrent KvDatabase.open calls create one resource set and close is idempotent', async () => {
    const mock = installSqliteMock();
    const db = new KvDatabase(':memory:');
    try {
        await Promise.all([db.open(), db.open(), db.open()]);
        assertEquals(mock.counters.opens, 1, 'concurrent opens should share one SQLite handle');
        db.close();
        db.close();
        assertEquals(mock.counters.closes, 1, 'handle should close exactly once');
        assertEquals(mock.counters.finalizes, mock.counters.prepares, 'all created statements should finalize');
    } finally {
        db.close();
        mock.restore();
    }
});
