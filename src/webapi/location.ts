class DOMStringList extends Array implements globalThis.DOMStringList {
    contains(string: string): boolean {
        return this.includes(string);
    }

    item(index: number): string | null {
        return this.at(index) ?? null;
    }
}

class Location implements globalThis.Location {
    ancestorOrigins: DOMStringList = new DOMStringList();

    #navigate(_url?: string | URL): never {
        throw new Error('Not supported');
    }

    get href(): string { return 'about:blank'; }
    set href(url: string) { this.#navigate(url); }

    get origin(): string { return 'null'; }

    get protocol(): string { return 'about:'; }
    set protocol(value: string) { this.#navigate(value); }

    get host(): string { return ''; }
    set host(value: string) { this.#navigate(value); }

    get hostname(): string { return ''; }
    set hostname(value: string) { this.#navigate(value); }

    get port(): string { return ''; }
    set port(value: string) { this.#navigate(value); }

    get pathname(): string { return 'blank'; }
    set pathname(value: string) { this.#navigate(value); }

    get search(): string { return ''; }
    set search(value: string) { this.#navigate(value); }

    get hash(): string { return ''; }
    set hash(value: string) { this.#navigate(value); }

    toString(): string {
        return this.href;
    }

    assign(url: string | URL): void {
        this.#navigate(url);
    }

    reload(): void {
        throw new Error('Not supported');
    }

    replace(url: string | URL): void {
        this.#navigate(url);
    }
}

Reflect.set(globalThis, "Location", Location);
Reflect.set(globalThis, "location", new Location());
