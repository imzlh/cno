/**
 * Local type boundary for network diagnostics hooks.
 *
 * The hooks are installed by the outer compatibility layer and exposed to
 * Node through the native debug namespace. Keeping these structural types in
 * the Node tree avoids a compile-time dependency on cno/src/utils.
 */
export interface NetworkCallFrame {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
}

export interface FetchHook {
    onRequest?(info: unknown): void;
    onResponse?(info: unknown): void;
    onData?(info: unknown): void;
    onFinished?(info: unknown): void;
}

export interface ServeHook {
    onRequest?(info: unknown): void;
    onResponse?(info: unknown): void;
    onData?(info: unknown): void;
    onFinished?(info: unknown): void;
}
