import { KvDatabase } from './db';

const sqlite3 = import.meta.use('sqlite3');

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

    sqlite3.open = (...args) => {
        counters.opens++;
        const handle = originalOpen(...args);
        const { exec, prepare, close } = handle;
        handle.exec = sql => {
            execCount++;
            if (failExecAt === execCount) throw new Error(`injected exec failure ${execCount}`);
            exec.call(handle, sql);
        };
        handle.prepare = sql => {
            const statement = prepare.call(handle, sql);
            counters.prepares++;
            const { finalize } = statement;
            let finalized = false;
            statement.finalize = () => {
                finalize.call(statement);
                if (!finalized) counters.finalizes++;
                finalized = true;
            };
            return statement;
        };
        handle.close = () => {
            counters.closes++;
            close.call(handle);
        };
        return handle;
    };

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
