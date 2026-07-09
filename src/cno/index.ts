Object.defineProperty(globalThis, 'CNO', {
    enumerable: true,
    writable: false,
    configurable: false,
    value: {}
});

await import('./llhttp');
await import('./pty');
