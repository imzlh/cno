// Copyright 2018-2025 the Deno authors. MIT license.
// Copyright 2026 iz

type DenoErrorOptions = { cause?: unknown };

function applyErrorOptions(error: Error, options?: DenoErrorOptions): void {
    if (options === undefined || options === null) return;
    if (!Object.prototype.hasOwnProperty.call(options, 'cause')) return;
    Object.defineProperty(error, 'cause', {
        value: options.cause,
        writable: true,
        configurable: true,
    });
}

class DenoError extends Error {
    declare code?: string;

    constructor(name: string, msg = '', options?: DenoErrorOptions) {
        super(msg);
        this.name = name;
        applyErrorOptions(this, options);
    }
}

// The subclasses only differ in `name` (and a static errno `code` on a few);
// the factory keeps instance `name`, own `code` property and instanceof
// behavior identical to the previous hand-written classes.
const errorClass = (name: string, code?: string) => {
    const clazz = class extends DenoError {
        constructor(msg = '', options?: DenoErrorOptions) {
            super(name, msg, options);
            if (code !== undefined) this.code = code;
        }
    };
    // The declarations above exposed their class name via `constructor.name`.
    Object.defineProperty(clazz, 'name', { value: name, configurable: true });
    return clazz;
};

const errors = {
    NotFound: errorClass("NotFound", "ENOENT"),
    PermissionDenied: errorClass("PermissionDenied", "EACCES"),
    ConnectionRefused: errorClass("ConnectionRefused"),
    ConnectionReset: errorClass("ConnectionReset"),
    ConnectionAborted: errorClass("ConnectionAborted"),
    NotConnected: errorClass("NotConnected"),
    AddrInUse: errorClass("AddrInUse"),
    AddrNotAvailable: errorClass("AddrNotAvailable"),
    BrokenPipe: errorClass("BrokenPipe"),
    AlreadyExists: errorClass("AlreadyExists", "EEXIST"),
    InvalidData: errorClass("InvalidData"),
    TimedOut: errorClass("TimedOut"),
    Interrupted: errorClass("Interrupted"),
    WriteZero: errorClass("WriteZero"),
    WouldBlock: errorClass("WouldBlock"),
    UnexpectedEof: errorClass("UnexpectedEof"),
    BadResource: errorClass("BadResource"),
    Http: errorClass("Http"),
    Busy: errorClass("Busy"),
    NotSupported: errorClass("NotSupported"),
    FilesystemLoop: errorClass("FilesystemLoop"),
    IsADirectory: errorClass("IsADirectory", "EISDIR"),
    NetworkUnreachable: errorClass("NetworkUnreachable"),
    NotADirectory: errorClass("NotADirectory", "ENOTDIR"),
    NotCapable: errorClass("NotCapable"),
};

export { errors };
