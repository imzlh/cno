await import('urlpattern-polyfill');

const URLPatternCtor = Reflect.get(globalThis, 'URLPattern') as typeof URLPattern;
const originalRegExpExec = RegExp.prototype.exec;

function withOriginalRegExpExec<T>(callback: () => T): T {
    const current = RegExp.prototype.exec;
    if (current === originalRegExpExec) return callback();
    RegExp.prototype.exec = originalRegExpExec;
    try {
        return callback();
    } finally {
        RegExp.prototype.exec = current;
    }
}

function SafeURLPattern(this: object, ...args: unknown[]) {
    if (!new.target) throw new TypeError("Class constructor URLPattern cannot be invoked without 'new'");
    return withOriginalRegExpExec(() => Reflect.construct(URLPatternCtor, args, new.target));
}

Object.defineProperty(SafeURLPattern, 'name', { value: 'URLPattern', configurable: true });
Object.setPrototypeOf(SafeURLPattern, URLPatternCtor);
SafeURLPattern.prototype = Object.create(URLPatternCtor.prototype, {
    constructor: { value: SafeURLPattern, writable: true, configurable: true },
    test: {
        value: function(...args: unknown[]): boolean {
            return withOriginalRegExpExec(() => Reflect.apply(URLPatternCtor.prototype.test, this, args));
        },
        writable: true,
        configurable: true,
    },
    exec: {
        value: function(...args: unknown[]): URLPatternResult | null {
            return withOriginalRegExpExec(() => Reflect.apply(URLPatternCtor.prototype.exec, this, args));
        },
        writable: true,
        configurable: true,
    },
});
Reflect.set(globalThis, 'URLPattern', SafeURLPattern);
