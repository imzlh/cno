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
    if (encoding === undefined) encoding = 'hex';
    if (encoding !== 'hex' && encoding !== 'base64' && encoding !== 'base64url' && encoding !== 'buffer') {
        throw new TypeError('Invalid UUID encoding');
    }
    const explicit = timestamp !== undefined;
    const time = timestamp instanceof Date ? timestamp.getTime() : explicit ? timestamp : Date.now();
    if (typeof time !== 'number' || !Number.isInteger(time) || time < 0 || time > MAX_TIMESTAMP) {
        throw new RangeError('UUID timestamp must be an integer between 0 and 2^48 - 1');
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
