if (!Object.prototype.hasOwnProperty.call(globalThis, 'CNO')) {
    Object.defineProperty(globalThis, 'CNO', {
        enumerable: true,
        writable: false,
        configurable: false,
        value: {}
    });
}

await import('./llhttp');
await import('./pty');
