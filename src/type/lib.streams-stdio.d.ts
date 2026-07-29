/**
 * Stdio singletons are injected onto the native `streams` module by
 * cno/src/utils/stdio.ts (not native circu.js). Node polyfills and CLI code
 * reach them via import.meta.use('streams').
 */
declare namespace CModuleStreams {
    export interface StdioStream {
        readonly fd: number;
        readonly isTTY: boolean;
        readonly isClosed: boolean;
        get size(): { width: number; height: number };
        read(buf: Uint8Array): Promise<number | null>;
        readSync(buf: Uint8Array): number | null;
        write(data: Uint8Array): Promise<number>;
        writeSync(data: Uint8Array): number;
        setRaw(mode: boolean, cbreak?: boolean): void;
        close(): void;
        createReadStream(): ReadableStream<Uint8Array>;
        createWriteStream(): WritableStream<Uint8Array>;
    }

    export const stdin: StdioStream;
    export const stdout: StdioStream;
    export const stderr: StdioStream;
}
