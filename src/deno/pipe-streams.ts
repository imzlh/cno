/** Stream constructors over a native circu.js pipe. */

import { wrapFSErr } from "../utils/wrap";
import { malloc } from "../utils/malloc";

const stream = import.meta.use('streams');

/** Closing a socket a racing teardown already closed is expected, not an error. */
export function closeStreamQuietly(pipe: { close(): unknown }): void {
    try {
        pipe.close();
    } catch {
        // Already closed.
    }
}

export const useWritable = (pipe: CModuleStreams.Stream) => new WritableStream({
    write: async (chunk) => {
        try {
            await pipe.write(chunk);
        } catch (e) {
            closeStreamQuietly(pipe);
            throw wrapFSErr(e);
        }
    },
    close: () => pipe.close(),
    abort: () => closeStreamQuietly(pipe),
});

export const useReadable = (pipe: CModuleStreams.Stream) => new ReadableStream({
    async pull(controller) {
        try {
            const buf = malloc(controller);
            const n = await pipe.read(buf);
            if (n === 0) {
                controller.close();
            } else {
                controller.enqueue(buf.slice(0, n));
            }
        } catch (e) {
            closeStreamQuietly(pipe);
            controller.error(wrapFSErr(e));
        }
    },
    cancel: () => closeStreamQuietly(pipe),
});
