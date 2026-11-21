import { utf8Decode } from '../utils/bytes';
import { isBunFile, readBunFileBytes } from './file';

const engine = import.meta.use('engine');
const ssl = import.meta.use('ssl');
const os = import.meta.use('os');

const arrayBufferIsView = ArrayBuffer.isView;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')!.get!;
const supportedOptions = new Set([
    'ca', 'cert', 'key', 'ALPNProtocols', 'serverName', 'servername', 'rejectUnauthorized', 'requestCert',
]);

export interface BunTlsConfig {
    cert?: string;
    key?: string;
    caCerts?: string[];
    alpnProtocols?: string[];
    servername?: string;
}

function tlsBytes(value: unknown, label: string): Uint8Array {
    if (engine.isArrayBuffer(value)) return new Uint8Array(value as ArrayBuffer);
    if (!arrayBufferIsView(value)) throw new TypeError(`${label} must be a string, BufferSource, or BunFile`);
    let buffer: ArrayBufferLike;
    let offset: number;
    let length: number;
    try {
        buffer = Reflect.apply(typedArrayBuffer, value, []);
        offset = Reflect.apply(typedArrayByteOffset, value, []);
        length = Reflect.apply(typedArrayByteLength, value, []);
    } catch {
        buffer = Reflect.apply(dataViewBuffer, value, []);
        offset = Reflect.apply(dataViewByteOffset, value, []);
        length = Reflect.apply(dataViewByteLength, value, []);
    }
    return new Uint8Array(buffer, offset, length);
}

function pemMaterial(value: unknown, label: string): string {
    const pem = typeof value === 'string' ? value
        : engine.decodeString(isBunFile(value) ? readBunFileBytes(value) : tlsBytes(value, label));
    if (!pem.trim() || pem.includes('\0')) throw new TypeError(`${label} must contain PEM data without NUL bytes`);
    return pem;
}

function identityMaterial(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
        if (value.length !== 1) throw new TypeError(`${label}: multiple TLS identities are not supported`);
        value = value[0];
    }
    return pemMaterial(value, label);
}

function alpnProtocols(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    const bytes = typeof value === 'string' ? new Uint8Array(engine.encodeString(value))
        : tlsBytes(value, 'TLS ALPNProtocols');
    if (bytes.length > 255) throw new RangeError('TLS ALPNProtocols exceeds the native 255-byte limit');
    const protocols: string[] = [];
    for (let offset = 0; offset < bytes.length;) {
        const length = bytes[offset++];
        if (length === 0 || offset + length > bytes.length) {
            throw new TypeError('TLS ALPNProtocols must contain length-prefixed protocol names');
        }
        const protocol = utf8Decode(bytes.subarray(offset, offset + length), true);
        if (protocol.includes('\0')) throw new TypeError('TLS ALPNProtocols cannot contain NUL bytes');
        protocols.push(protocol);
        offset += length;
    }
    return protocols;
}

export function normalizeTlsOptions(input: unknown, role: 'client' | 'server'): BunTlsConfig | undefined {
    if (input === undefined || input === false) return undefined;
    if (input !== true && (input === null || typeof input !== 'object' || Array.isArray(input))) {
        throw new TypeError('TLS options must be a boolean or an object');
    }
    const options = (input === true ? {} : input) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(options)) {
        if (typeof key !== 'string' || !supportedOptions.has(key)) {
            if (Reflect.get(options, key) !== undefined) throw new TypeError(`Unsupported TLS option: ${String(key)}`);
        }
    }
    if (options.requestCert !== undefined && options.requestCert !== false) {
        throw new TypeError('TLS requestCert is not supported by the host');
    }
    const rejectUnauthorized = options.rejectUnauthorized;
    if (rejectUnauthorized !== undefined && typeof rejectUnauthorized !== 'boolean') {
        throw new TypeError('TLS rejectUnauthorized must be a boolean');
    }
    if (role === 'client') {
        let rejectByDefault = true;
        if (rejectUnauthorized === undefined) {
            try { rejectByDefault = os.getenv('NODE_TLS_REJECT_UNAUTHORIZED') !== '0'; } catch {}
        }
        if (rejectUnauthorized === false || !rejectByDefault) {
            throw new TypeError('TLS rejectUnauthorized: false is not supported by the host');
        }
    }
    const servername = options.serverName ?? options.servername;
    if (servername !== undefined && (typeof servername !== 'string' || servername.length === 0 || servername.includes('\0'))) {
        throw new TypeError('TLS serverName must be a non-empty string without NUL bytes');
    }
    if (role === 'server' && servername !== undefined) throw new TypeError('TLS serverName selection is not supported by the host');

    const config: BunTlsConfig = {
        cert: identityMaterial(options.cert, 'TLS cert'),
        key: identityMaterial(options.key, 'TLS key'),
        alpnProtocols: alpnProtocols(options.ALPNProtocols),
        servername,
    };
    if (options.ca !== undefined) {
        if (role === 'client' && (os.platform === 'windows' || os.platform === 'win32')) {
            throw new TypeError('Replacing the TLS CA store is not supported by the Windows host');
        }
        const ca = Array.isArray(options.ca) ? options.ca : [options.ca];
        config.caCerts = ca.map(value => pemMaterial(value, 'TLS ca'));
    }
    if ((config.cert === undefined) !== (config.key === undefined)) throw new TypeError('TLS cert and key must be supplied together');
    if (role === 'server' && config.cert === undefined) throw new TypeError('TLS server requires cert and key');

    // Validate before host networking: connectTls constructs its context after TCP connects.
    new ssl.Context({
        mode: role,
        cert: config.cert,
        key: config.key,
        ca: config.caCerts?.length ? config.caCerts.join('\n') : undefined,
        alpn: config.alpnProtocols,
    });
    return config;
}
