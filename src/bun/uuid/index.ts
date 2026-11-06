import { Buffer } from '../../node/buffer';

const crypto = import.meta.use('crypto');
type Encoding = 'hex' | 'base64' | 'base64url' | 'buffer';
type State = { timestamp: number; requested: number; counter: number };
const defaultState: State = { timestamp: -1, requested: -1, counter: 0 };
const explicitState: State = { timestamp: -1, requested: -1, counter: 0 };
const MAX_TIMESTAMP = 2 ** 48 - 1;

export function randomUUIDv7(encoding: 'buffer', timestamp?: number | Date): Buffer;
export function randomUUIDv7(encoding?: Exclude<Encoding, 'buffer'>, timestamp?: number | Date): string;
export function randomUUIDv7(timestamp?: number | Date): string;
export function randomUUIDv7(encoding?: Encoding | number | Date, timestamp?: number | Date): string | Buffer {
    if (typeof encoding === 'number' || encoding instanceof Date) {
        timestamp = encoding;
        encoding = 'hex';
    }
    const boxedEncoding = typeof encoding === 'object' && encoding !== null
        ? (() => { try { return String.prototype.valueOf.call(encoding); } catch { return undefined; } })()
        : undefined;
    if (typeof encoding === 'string' || boxedEncoding !== undefined) {
        encoding = (typeof encoding === 'string' ? encoding : boxedEncoding!).toLowerCase() as Encoding;
        if (encoding !== 'hex' && encoding !== 'base64' && encoding !== 'base64url' && encoding !== 'buffer') {
            throw Object.assign(
                new TypeError('Encoding must be one of base64, base64url, hex, or buffer'),
                { code: 'ERR_UNKNOWN_ENCODING' },
            );
        }
    } else if (timestamp !== undefined || encoding === undefined) {
        encoding = 'hex';
    } else {
        // With one non-string argument Bun treats it as the timestamp.
        timestamp = encoding as number | Date;
        encoding = 'hex';
    }
    const explicit = timestamp !== undefined;
    const time = timestamp instanceof Date ? timestamp.getTime() : explicit ? timestamp : Date.now();
    if (typeof time !== 'number') {
        throw Object.assign(
            new TypeError(`The "timestamp" property must be of type number. Received ${typeof time}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    if (!Number.isInteger(time)) {
        if (Number.isFinite(time)) {
            throw Object.assign(
                new TypeError('The "timestamp" property must be of type integer. Received number'),
                { code: 'ERR_INVALID_ARG_TYPE' },
            );
        }
        throw Object.assign(
            new RangeError(`The value of "timestamp" is out of range. It must be >= 0 and <= ${MAX_TIMESTAMP}. Received ${time}`),
            { code: 'ERR_OUT_OF_RANGE' },
        );
    }
    if (time < 0 || time > MAX_TIMESTAMP) {
        throw Object.assign(
            new RangeError(`The value of "timestamp" is out of range. It must be >= 0 and <= ${MAX_TIMESTAMP}. Received ${time}`),
            { code: 'ERR_OUT_OF_RANGE' },
        );
    }

    const bytes = new Uint8Array(16);
    crypto.randomFill(bytes);
    const state = explicit ? explicitState : defaultState;
    let emitted = time;
    if (explicit ? time === state.requested : time <= state.timestamp) {
        emitted = state.timestamp;
        if (state.counter === 0xfff) {
            if (emitted === MAX_TIMESTAMP) throw new RangeError('UUID timestamp overflow');
            emitted++;
            state.counter = 0;
        } else {
            state.counter++;
        }
    } else {
        state.counter = ((bytes[6] << 8) | bytes[7]) & 0x7ff;
    }
    state.requested = time;
    state.timestamp = emitted;
    for (let i = 5; i >= 0; i--) {
        bytes[i] = emitted % 256;
        emitted = Math.floor(emitted / 256);
    }
    bytes[6] = 0x70 | (state.counter >> 8);
    bytes[7] = state.counter & 0xff;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const buffer = Buffer.from(bytes);
    if (encoding === 'buffer') return buffer;
    if (encoding !== 'hex') return buffer.toString(encoding);
    const hex = buffer.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
