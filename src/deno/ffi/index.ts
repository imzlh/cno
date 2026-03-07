/**
 * Deno FFI Module
 * 
 * Foreign Function Interface for calling native C libraries
 */

export { UnsafePointer, UnsafePointerView } from './pointer';
export { UnsafeCallback } from './callback';
export { dlopen, DynamicLibraryImpl } from './library';

import { UnsafePointer, UnsafePointerView } from './pointer';
import { UnsafeCallback } from './callback';
import { dlopen } from './library';

Object.assign(Deno, {
    dlopen,
    UnsafePointer,
    UnsafePointerView,
    UnsafeCallback,
});