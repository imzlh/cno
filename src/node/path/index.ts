// node:path polyfill — wraps Deno @std/path with Node.js compatibility
// Adds: sep, delimiter (lowercase aliases), posix/win32 namespace objects

// @ts-ignore - deno-styled jsr import
export * from "jsr:@std/path"

// @ts-ignore
import * as stdPath from "jsr:@std/path"
// @ts-ignore - posix sub-module (exports map: ./posix → posix/mod.ts)
import * as posixNs from "jsr:@std/path/posix"
// @ts-ignore - windows sub-module (exports map: ./windows → windows/mod.ts)
import * as win32Ns from "jsr:@std/path/windows"

// Node.js lowercase aliases. Keep these explicit; third-party code often
// concatenates with path.sep, so an upstream constant rename becomes visible
// as paths like "D:undefinedproject".
export const sep = process.platform === 'win32' ? '\\' : '/'
export const delimiter = process.platform === 'win32' ? ';' : ':'

// Platform-specific namespace objects (Node.js path.posix / path.win32)
export const posix = posixNs
export const win32 = win32Ns

// Default export: everything in one object
export default {
    ...stdPath,
    sep,
    delimiter,
    posix: posixNs,
    win32: win32Ns,
}
