import { Buffer } from '../../node/buffer';

const crypto = import.meta.use('crypto');
type Encoding = 'hex' | 'base64' | 'base64url' | 'buffer';
type State = { timestamp: number; requested: number; counter: number };
const defaultState: State = { timestamp: -1, requested: -1, counter: 0 };
const explicitState: State = { timestamp: -1, requested: -1, counter: 0 };
const MAX_TIMESTAMP = 2 ** 48 - 1;
const stringValueOf = String.prototype.valueOf;
const dateGetTime = Date.prototype.getTime;

interface RandomUUIDv7 {
    (encoding: 'buffer', timestamp?: number | Date): Buffer;
    (encoding?: Exclude<Encoding, 'buffer'>, timestamp?: number | Date): string;
    (timestamp?: number | Date): string;
}

function isStringObject(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    try {
        Reflect.apply(stringValueOf, value, []);
        return true;
    } catch {
        return false;
    }
}

function dateMilliseconds(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return value;
    try {
        return Reflect.apply(dateGetTime, value, []);
    } catch {
        return value;
    }
}

export const randomUUIDv7 = {
  randomUUIDv7(encoding?: Encoding | number | Date, timestamp?: number | Date): string | Buffer {
    let format: Encoding = 'hex';
    if (typeof encoding === 'string' || isStringObject(encoding)) {
        format = String(encoding).toLowerCase() as Encoding;
        if (format !== 'hex' && format !== 'base64' && format !== 'base64url' && format !== 'buffer') {
            throw Object.assign(
                new TypeError('Encoding must be one of base64, base64url, hex, or buffer'),
                { code: 'ERR_UNKNOWN_ENCODING' },
            );
        }
    } else if (timestamp === undefined && encoding !== undefined) {
        // With one non-string argument Bun treats it as the timestamp.
        timestamp = encoding as number | Date;
    }
    const explicit = timestamp !== undefined;
    const time = explicit ? dateMilliseconds(timestamp) : Date.now();
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
    if (format === 'buffer') return buffer;
    if (format !== 'hex') return buffer.toString(format);
    const hex = buffer.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  },
}.randomUUIDv7 as RandomUUIDv7;
