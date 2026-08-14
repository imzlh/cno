/**
 * node:http2 SETTINGS validation, packing and unpacking:
 * getDefaultSettings / getPackedSettings / getUnpackedSettings plus the
 * shared value validators the session uses.
 */

import { Buffer } from '../buffer';
import {
    SETTINGS_ENABLE_CONNECT_PROTOCOL,
    SETTINGS_ENABLE_PUSH,
    SETTINGS_INITIAL_WINDOW_SIZE,
    SETTINGS_MAX_FRAME_SIZE,
    SETTINGS_MAX_HEADER_LIST_SIZE,
    SETTING_ID_TO_NAME,
    SETTING_NAME_TO_ID,
    constants,
} from './constants';
import { describeReceived, invalidSettingValue, tooManyCustomSettings } from './errors';

export function settingsValueAsUint32(id: number, value: unknown): number {
    const name = SETTING_ID_TO_NAME[id] ?? String(id);
    // Node accepts ONLY booleans for the two flag settings: 0/1/'1'/null all
    // raise ERR_HTTP2_INVALID_SETTING_VALUE (measured on node v24.18.0).
    if (id === SETTINGS_ENABLE_PUSH || id === SETTINGS_ENABLE_CONNECT_PROTOCOL) {
        if (typeof value !== 'boolean') throw invalidSettingValue(name, value);
        return value ? 1 : 0;
    }
    if (typeof value === 'boolean') throw invalidSettingValue(name, value);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff || !Number.isInteger(n)) {
        throw invalidSettingValue(name, value);
    }
    if (id === SETTINGS_MAX_FRAME_SIZE && (n < 16384 || n > 16777215)) {
        throw invalidSettingValue(name, n);
    }
    if (id === SETTINGS_INITIAL_WINDOW_SIZE && n > 0x7fffffff) {
        throw invalidSettingValue(name, n);
    }
    return n >>> 0;
}

/** Node's internal MAX_ADDITIONAL_SETTINGS: >10 custom entries is an error. */
export const MAX_ADDITIONAL_SETTINGS = 10;

/**
 * Validate and collect `customSettings` (unknown SETTINGS ids) for packing.
 * Node keys these by numeric id; ids must be uint16 and values uint32.
 */
export function customSettingEntries(raw: unknown): Array<[number, number]> {
    if (raw === null || typeof raw !== 'object') return [];
    const keys = Object.keys(raw as Record<string, unknown>);
    if (keys.length > MAX_ADDITIONAL_SETTINGS) throw tooManyCustomSettings();
    const entries: Array<[number, number]> = [];
    for (const key of keys) {
        const id = Number(key);
        if (!Number.isInteger(id) || id < 0 || id > 0xffff) {
            throw invalidSettingValue('customSettings:id', key);
        }
        // A custom id that duplicates a named setting is ambiguous; Node fails
        // here too, but with an unrelated ERR_INVALID_ARG_TYPE from an internal
        // path, so we raise the coherent error instead.
        if (SETTING_ID_TO_NAME[id] !== undefined) {
            throw invalidSettingValue('customSettings:id', key);
        }
        const value = (raw as Record<string, unknown>)[key];
        if (typeof value === 'boolean') {
            throw invalidSettingValue('customSettings:value', value);
        }
        const n = Number(value);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 0xffffffff) {
            throw invalidSettingValue('customSettings:value', value);
        }
        entries.push([id, n >>> 0]);
    }
    return entries;
}

export function getDefaultSettings(): Record<string, number | boolean> {
    // Node returns a null-prototype object.
    const out = Object.create(null) as Record<string, number | boolean>;
    out['headerTableSize'] = constants.DEFAULT_SETTINGS_HEADER_TABLE_SIZE;
    out['enablePush'] = true;
    out['initialWindowSize'] = 65535;
    out['maxFrameSize'] = 16384;
    out['maxConcurrentStreams'] = 4294967295;
    out['maxHeaderSize'] = constants.DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE;
    out['maxHeaderListSize'] = constants.DEFAULT_SETTINGS_MAX_HEADER_LIST_SIZE;
    out['enableConnectProtocol'] = false;
    return out;
}

/**
 * Serialize HTTP/2 SETTINGS parameters to the SETTINGS frame payload
 * (sequence of 6-byte entries: 2-byte id BE + 4-byte value BE).
 * Matches Node.js `http2.getPackedSettings`.
 */
export function getPackedSettings(
    settings?: Record<string, number | boolean | Record<string, number> | undefined>,
): Buffer {
    // Node treats a missing/undefined argument as {} and returns an empty
    // buffer; only null and non-objects are ERR_INVALID_ARG_TYPE.
    if (settings === undefined) return Buffer.alloc(0);
    if (settings === null || typeof settings !== 'object') {
        throw Object.assign(
            new TypeError(`The "settings" argument must be of type object. Received ${describeReceived(settings)}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    const entries: Array<[number, number]> = [];
    for (const [name, raw] of Object.entries(settings)) {
        if (raw === undefined) continue;
        if (name === 'customSettings') continue;
        const id = SETTING_NAME_TO_ID[name];
        if (id === undefined) continue;
        entries.push([id, settingsValueAsUint32(id, raw)]);
    }
    for (const entry of customSettingEntries(settings['customSettings'])) {
        entries.push(entry);
    }
    // Stable order by identifier (Node sorts by id)
    entries.sort((a, b) => a[0] - b[0]);
    // maxHeaderSize aliases maxHeaderListSize — pack once
    const seen = new Set<number>();
    const unique: Array<[number, number]> = [];
    for (const e of entries) {
        if (seen.has(e[0])) continue;
        seen.add(e[0]);
        unique.push(e);
    }
    const out = Buffer.allocUnsafe(unique.length * 6);
    let off = 0;
    for (const [id, val] of unique) {
        out.writeUInt16BE(id, off);
        out.writeUInt32BE(val, off + 2);
        off += 6;
    }
    return out;
}

/**
 * Parse SETTINGS frame payload bytes into a settings object.
 * Unknown identifiers are ignored. Boolean settings become boolean.
 */
export function getUnpackedSettings(
    buf: Buffer | Uint8Array,
): Record<string, number | boolean | Record<string, number>> {
    if (!(buf instanceof Uint8Array)) {
        throw Object.assign(
            new TypeError('The "buf" argument must be an instance of Buffer or TypedArray. '
                + `Received ${describeReceived(buf)}`),
            { code: 'ERR_INVALID_ARG_TYPE' },
        );
    }
    const u8 = buf;
    if (u8.byteLength % 6 !== 0) {
        throw Object.assign(
            new RangeError('Packed settings length must be a multiple of six'),
            { code: 'ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH' },
        );
    }
    const view = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
    const out: Record<string, number | boolean | Record<string, number>> = {};
    // Node surfaces unrecognized ids under `customSettings`, keyed by numeric
    // id, created lazily at the first unknown id (so key order follows the
    // wire scan) with last-one-wins on duplicates.
    let custom: Record<string, number> | undefined;
    for (let i = 0; i < view.length; i += 6) {
        const id = view.readUInt16BE(i);
        const val = view.readUInt32BE(i + 2);
        const name = SETTING_ID_TO_NAME[id];
        if (!name) {
            if (custom === undefined) {
                custom = {};
                out['customSettings'] = custom;
            }
            custom[String(id)] = val;
            continue;
        }
        // Node emits maxHeaderSize before its maxHeaderListSize alias.
        if (id === SETTINGS_MAX_HEADER_LIST_SIZE) {
            out['maxHeaderSize'] = val;
            out['maxHeaderListSize'] = val;
            continue;
        }
        if (id === SETTINGS_ENABLE_PUSH || id === SETTINGS_ENABLE_CONNECT_PROTOCOL) {
            out[name] = val !== 0;
        } else {
            out[name] = val;
        }
    }
    return out;
}
