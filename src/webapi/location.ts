import { DOMException } from './events';

const os = import.meta.use('os');

class DOMStringList extends Array implements globalThis.DOMStringList {
    contains(string: string): boolean {
        return this.includes(string);
    }

    item(index: number): string | null {
        return this.at(index) ?? null;
    }
}

function notSupported(what: string): never {
    throw new DOMException(`Cannot set "${what}"`, 'NotSupportedError');
}

/** Mutable location backed by a URL; setters/navigation throw NotSupportedError (Deno). */
class LocationImpl implements globalThis.Location {
    ancestorOrigins: DOMStringList = new DOMStringList();
    #url: URL;

    constructor(href: string) {
        this.#url = new URL(href);
    }

    get href(): string { return this.#url.href; }
    set href(_v: string) { notSupported('location.href'); }

    get origin(): string { return this.#url.origin; }

    get protocol(): string { return this.#url.protocol; }
    set protocol(_v: string) { notSupported('location.protocol'); }

    get host(): string { return this.#url.host; }
    set host(_v: string) { notSupported('location.host'); }

    get hostname(): string { return this.#url.hostname; }
    set hostname(_v: string) { notSupported('location.hostname'); }

    get port(): string { return this.#url.port; }
    set port(_v: string) { notSupported('location.port'); }

    get pathname(): string { return this.#url.pathname; }
    set pathname(_v: string) { notSupported('location.pathname'); }

    get search(): string { return this.#url.search; }
    set search(_v: string) { notSupported('location.search'); }

    get hash(): string { return this.#url.hash; }
    set hash(_v: string) { notSupported('location.hash'); }

    toString(): string {
        return this.href;
    }

    assign(_url: string | URL): void {
        notSupported('location.assign');
    }

    reload(): void {
        notSupported('location.reload');
    }

    replace(_url: string | URL): void {
        notSupported('location.replace');
    }
}

// Without --location, Deno leaves location undefined (specs/run/_071_location_unset).
// With --location=<url>, install a frozen-assignment Location instance.
function installLocationFromFlag(): void {
    let raw: string | undefined;
    try {
        raw = os.getenv('CNO_LOCATION');
    } catch {
        raw = undefined;
    }
    if (!raw) {
        // Keep Location constructor public; leave global location unset.
        Reflect.set(globalThis, 'Location', LocationImpl);
        Object.defineProperty(globalThis, 'location', {
            get() { return undefined; },
            set() { notSupported('location'); },
            enumerable: true,
            configurable: true,
        });
        return;
    }

    let href = raw;
    try {
        href = new URL(raw).href;
    } catch {
        // Keep raw string if URL parse fails; constructor will throw.
    }
    const loc = new LocationImpl(href);
    Reflect.set(globalThis, 'Location', LocationImpl);
    Object.defineProperty(globalThis, 'location', {
        get() { return loc; },
        set() { notSupported('location'); },
        enumerable: true,
        configurable: true,
    });
}

installLocationFromFlag();

/** Re-apply after CLI parses --location (polyfill may load before flags). */
export function applyLocation(href: string): void {
    try { os.setenv('CNO_LOCATION', href); } catch { /* */ }
    const loc = new LocationImpl(new URL(href).href);
    Object.defineProperty(globalThis, 'location', {
        get() { return loc; },
        set() { notSupported('location'); },
        enumerable: true,
        configurable: true,
    });
}

Reflect.set(globalThis, '__cno_applyLocation', applyLocation);
