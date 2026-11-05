/** Shared object-URL state without a dependency on the URL or Blob modules. */
import type { Blob } from './formdata';

export const blobBytesSymbol = Symbol.for('cno.blob.bytes');

const objectUrlStore = new Map<string, Blob>();
let objectUrlCounter = 0;
let URLConstructor: new (input: string) => { readonly href: string };

export function setObjectURLConstructor(ctor: typeof URLConstructor): void {
    URLConstructor = ctor;
}

function normalizeObjectURL(url: string | globalThis.URL): string {
    // URL installs its constructor when loaded; later global replacements must
    // not change which parser the registry uses.
    return new URLConstructor(String(url)).href;
}

export function createObjectUrlId(): string {
    objectUrlCounter++;
    return `blob:/cno-${Date.now().toString(36)}-${objectUrlCounter.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function registerObjectURL(url: string, blob: Blob): void {
    objectUrlStore.set(url, blob);
}

export function resolveObjectURL(url: string | globalThis.URL): Blob | null {
    try {
        return objectUrlStore.get(normalizeObjectURL(url)) ?? null;
    } catch {
        return null;
    }
}

export function resolveObjectURLBytes(url: string | globalThis.URL): { type: string; bytes: Uint8Array } | null {
    const blob = resolveObjectURL(url);
    if (!blob) return null;
    return { type: blob.type, bytes: blob[blobBytesSymbol]() };
}

export function unregisterObjectURL(url: string | globalThis.URL): void {
    try {
        objectUrlStore.delete(normalizeObjectURL(url));
    } catch {
        // Browser-compatible no-op for invalid or unknown object URLs.
    }
}
