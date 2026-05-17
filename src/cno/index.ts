Object.defineProperty(globalThis, 'CNO', {
    enumerable: true,
    writable: false,
    configurable: false,
    value: {}
});

await import('./engine');
await import('./compress');
await import('./ssl');
await import('./llhttp');
await import('./pty');
