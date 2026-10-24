/** Self-contained: `cno setup` copies `cno/src/node/` on its own, so import nothing from outside this tree. */

/** Close a handle whose peer may already have closed it; teardown must not throw for that. */
export function closeQuietly(handle: { close(): unknown }): void {
    try {
        handle.close();
    } catch {
        // Already closed.
    }
}

/** `closeQuietly` reporting success, for callers that must not replace the error they are propagating. */
export function tryCloseQuietly(handle: { close(): unknown }): boolean {
    try {
        handle.close();
        return true;
    } catch {
        return false;
    }
}
