/**
 * Node.js inspector module (stub)
 * V8 inspector integration
 */

export function open(_port?: number, _host?: string, _wait?: boolean): void {}
export function close(): void {}
export function url(): string | undefined { return undefined; }
export function waitForDebugger(): void {}

export const console = {
    log(..._args: any[]): void {},
    warn(..._args: any[]): void {},
    error(..._args: any[]): void {},
    info(..._args: any[]): void {},
    dir(_object: any, _options?: any): void {},
    table(_data: any, _properties?: string[]): void {},
    trace(..._args: any[]): void {},
    assert(_condition?: boolean, ..._data: any[]): void {},
    clear(): void {},
    count(_label?: string): void {},
    countReset(_label?: string): void {},
    group(..._data: any[]): void {},
    groupCollapsed(..._data: any[]): void {},
    groupEnd(): void {},
    time(_label?: string): void {},
    timeEnd(_label?: string): void {},
    timeStamp(_label?: string): void {},
    profile(_label?: string): void {},
    profileEnd(_label?: string): void {},
};
