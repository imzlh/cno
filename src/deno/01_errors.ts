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
    constructor(name: string, msg = '', options?: DenoErrorOptions) {
        super(msg);
        this.name = name;
        applyErrorOptions(this, options);
    }
}

class BadResource extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("BadResource", msg, options);
    }
}

class Interrupted extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("Interrupted", msg, options);
    }
}

class NotCapable extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("NotCapable", msg, options);
    }
}

class NotFound extends DenoError {
    code = "ENOENT";

    constructor(msg = '', options?: DenoErrorOptions) {
        super("NotFound", msg, options);
    }
}

class ConnectionRefused extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("ConnectionRefused", msg, options);
    }
}

class ConnectionReset extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("ConnectionReset", msg, options);
    }
}

class ConnectionAborted extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("ConnectionAborted", msg, options);
    }
}

class NotConnected extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("NotConnected", msg, options);
    }
}

class AddrInUse extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("AddrInUse", msg, options);
    }
}

class AddrNotAvailable extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("AddrNotAvailable", msg, options);
    }
}

class BrokenPipe extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("BrokenPipe", msg, options);
    }
}

class AlreadyExists extends DenoError {
    code = "EEXIST";

    constructor(msg = '', options?: DenoErrorOptions) {
        super("AlreadyExists", msg, options);
    }
}

class InvalidData extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("InvalidData", msg, options);
    }
}

class TimedOut extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("TimedOut", msg, options);
    }
}

class WriteZero extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("WriteZero", msg, options);
    }
}

class WouldBlock extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("WouldBlock", msg, options);
    }
}

class UnexpectedEof extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("UnexpectedEof", msg, options);
    }
}

class Http extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("Http", msg, options);
    }
}

class Busy extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("Busy", msg, options);
    }
}

class PermissionDenied extends DenoError {
    code = "EACCES";

    constructor(msg = '', options?: DenoErrorOptions) {
        super("PermissionDenied", msg, options);
    }
}

class NotSupported extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("NotSupported", msg, options);
    }
}

class FilesystemLoop extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("FilesystemLoop", msg, options);
    }
}

class IsADirectory extends DenoError {
    code = "EISDIR";

    constructor(msg = '', options?: DenoErrorOptions) {
        super("IsADirectory", msg, options);
    }
}

class NetworkUnreachable extends DenoError {
    constructor(msg = '', options?: DenoErrorOptions) {
        super("NetworkUnreachable", msg, options);
    }
}

class NotADirectory extends DenoError {
    code = "ENOTDIR";

    constructor(msg = '', options?: DenoErrorOptions) {
        super("NotADirectory", msg, options);
    }
}

const errors = {
    NotFound,
    PermissionDenied,
    ConnectionRefused,
    ConnectionReset,
    ConnectionAborted,
    NotConnected,
    AddrInUse,
    AddrNotAvailable,
    BrokenPipe,
    AlreadyExists,
    InvalidData,
    TimedOut,
    Interrupted,
    WriteZero,
    WouldBlock,
    UnexpectedEof,
    BadResource,
    Http,
    Busy,
    NotSupported,
    FilesystemLoop,
    IsADirectory,
    NetworkUnreachable,
    NotADirectory,
    NotCapable,
};

export { errors };
