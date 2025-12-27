class DOMStringList extends Array implements globalThis.DOMStringList {
    contains(string: string): boolean {
        return this.includes(string);
    }

    item(index: number): string | null {
        return this.at(index) ?? null;
    }
}

class Location extends globalThis.URL implements globalThis.Location {
    ancestorOrigins: DOMStringList = new DOMStringList();
    assign(url: string): void {
        throw new Error('Not supported');
    }
    reload(forcedReload?: unknown): void {
        throw new Error('Not supported');
    }
    replace(url: string): void {
        throw new Error('Not supported');
    }
}

Reflect.set(globalThis, "location", new Location("about:blank"));