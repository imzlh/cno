/**
 * Structural view of the stdio singletons exposed on the native streams
 * namespace. The concrete owner lives outside the Node layer; Node reaches it
 * through import.meta.use('streams'), so this file deliberately contains only
 * the local type boundary.
 */
export interface NodeStdioStream {
    readonly fd: number;
    readonly isTTY: boolean;
    readonly isClosed: boolean;
    readonly size: { width: number; height: number };
    read(buf: Uint8Array): Promise<number | null>;
    readSync(buf: Uint8Array): number | null;
    write(data: Uint8Array): Promise<number>;
    writeSync(data: Uint8Array): number;
    setRaw(mode: boolean, cbreak?: boolean): void;
    close(): void;
    readonly __stream?: unknown;
}
