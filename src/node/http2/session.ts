/**
 * node:http2 sessions: the Http2Session base and the ClientHttp2Session that
 * attaches a cleartext or TLS transport and opens client streams.
 */

import { EventEmitter } from '../events';
import { Buffer } from '../buffer';
import { Socket } from '../net';
import type { TLSSocket } from '../tls';
import { setTimeout, clearTimeout } from '../timers';
import { H2Connection } from '@cnojs/http/h2';
import type { H2Header } from '@cnojs/http/h2-native';
import {
    SETTINGS_ENABLE_CONNECT_PROTOCOL,
    SETTINGS_ENABLE_PUSH,
    SETTING_ID_TO_NAME,
    SETTING_NAME_TO_ID,
    constants,
} from './constants';
import { h2Error, invalidArgType } from './errors';
import { toHeaderPairs } from './headers';
import { takeTcpForH2, takeTlsForH2 } from './transport';
import { customSettingEntries, getDefaultSettings, settingsValueAsUint32 } from './settings';
import { ClientHttp2Stream } from './stream';

/* ── Session base ─────────────────────────────────────────────── */

type Http2SettingsSnapshot = Record<string, number | boolean | Record<number, number> | undefined> & {
    headerTableSize?: number;
    enablePush?: boolean;
    maxConcurrentStreams?: number;
    initialWindowSize?: number;
    maxFrameSize?: number;
    maxHeaderListSize?: number;
    maxHeaderSize?: number;
    enableConnectProtocol?: boolean;
    customSettings?: Record<number, number>;
};

type NormalizedSessionSettings = Http2SettingsSnapshot;
type PingRequest = {
    startedAt: number;
    payload: Uint8Array;
    callback: (error: Error | null, duration: number, payload: Buffer) => void;
};

export function normalizeSessionSettings(settings: Record<string, unknown>): NormalizedSessionSettings {
    if (settings === null || typeof settings !== 'object') {
        throw invalidArgType('settings', 'of type object', settings);
    }
    const validated: NormalizedSessionSettings = {};
    for (const [name, raw] of Object.entries(settings)) {
        if (raw === undefined) continue;
        if (name === 'customSettings') {
            const entries = customSettingEntries(raw);
            if (entries.length) validated.customSettings = Object.fromEntries(entries);
            continue;
        }
        if (!Object.hasOwn(SETTING_NAME_TO_ID, name)) continue;
        const id = SETTING_NAME_TO_ID[name]!;
        const value = settingsValueAsUint32(id, raw);
        const key = SETTING_ID_TO_NAME[id]!;
        if (name === 'maxHeaderListSize' && validated[key] !== undefined) continue;
        validated[key] = (id === SETTINGS_ENABLE_PUSH || id === SETTINGS_ENABLE_CONNECT_PROTOCOL) ? value !== 0 : value;
    }
    return validated;
}

export class Http2Session extends EventEmitter {
    protected conn: H2Connection | null = null;
    socket: Socket | null = null;
    closed = false;
    destroyed = false;
    type: number;
    /** Set once a transport is attached; before that Node reports undefined. */
    protected _alpnProtocol: string | false | undefined;
    protected _encrypted: boolean | undefined;
    protected _connecting = true;
    private _remoteSettings: Http2SettingsSnapshot = {};
    private _localSettings: Http2SettingsSnapshot = {};
    private submittedSettings: Record<string, unknown> = getDefaultSettings();
    pendingSettingsAck = false;
    /** Settings requested before a transport existed; flushed on attach. */
    private queuedSettings: Array<Record<string, unknown>> = [];
    private settingsAckWaiters: Array<((s: Http2Session) => void) | undefined> = [];
    private timeoutMs = 0;
    private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    private _originSet: string[] | undefined;
    private readonly pingRequests = new Map<string, PingRequest[]>();
    protected readonly pendingStreams = new Set<ClientHttp2Stream>();
    protected readonly initialSettings: NormalizedSessionSettings;

    constructor(type: number, initialSettings?: Record<string, unknown>) {
        super();
        this.type = type;
        this.initialSettings = initialSettings ? this.mergeLocalSettings(initialSettings) : {};
        this._localSettings = { ...getDefaultSettings(), ...this.initialSettings };
    }

    /** Validate before updating the submitted (not yet acknowledged) settings. */
    private mergeLocalSettings(settings: Record<string, unknown>): NormalizedSessionSettings {
        const validated = normalizeSessionSettings(settings);
        const previousCustom = this.submittedSettings['customSettings'] as Record<number, number> | undefined;
        Object.assign(this.submittedSettings, validated);
        if (validated.customSettings) {
            this.submittedSettings['customSettings'] = { ...previousCustom, ...validated.customSettings };
        }
        if (validated['maxHeaderListSize'] !== undefined) {
            this.submittedSettings['maxHeaderSize'] = validated['maxHeaderListSize'];
        }
        return validated;
    }

    get remoteSettings(): Http2SettingsSnapshot { return this._remoteSettings; }
    get localSettings(): Http2SettingsSnapshot { return this._localSettings; }

    /** Live: undefined until a transport is attached (matches Node). */
    get alpnProtocol(): string | false | undefined {
        return this._alpnProtocol;
    }

    get encrypted(): boolean | undefined {
        return this._encrypted;
    }

    get connecting(): boolean {
        return this._connecting;
    }

    /** Node reports `{}` while connecting; afterwards, what the session knows. */
    get state(): Record<string, number> {
        const session = this.conn?.session;
        if (!session) return {};
        const out: Record<string, number> = {};
        // nghttp2 exposes only the connection-level windows through this build.
        const local = session.localWnd;
        const remote = session.remoteWnd;
        if (typeof local === 'number') {
            out['effectiveLocalWindowSize'] = local;
            out['localWindowSize'] = local;
        }
        if (typeof remote === 'number') out['remoteWindowSize'] = remote;
        if (typeof session.nextStreamId === 'number') out['nextStreamID'] = session.nextStreamId;
        return out;
    }

    /** Node: undefined unless an ORIGIN frame was received. Never populated here. */
    get originSet(): string[] | undefined {
        return this._encrypted ? (this._originSet ?? []) : undefined;
    }

    /** Called by subclasses/attach paths once a transport exists. */
    protected onTransportAttached(secure: boolean, alpn?: string | false): void {
        this._connecting = false;
        this._encrypted = secure;
        this._alpnProtocol = secure ? (alpn ?? 'h2') : false;
        const session = this.conn!.session;
        this._localSettings = { ...session.localSettings };
        this._remoteSettings = { ...session.remoteSettings };
        session.onping = (isAck, payload) => {
            if (!isAck) return;
            const key = pingPayloadKey(payload);
            const requests = this.pingRequests.get(key);
            const request = requests?.shift();
            if (requests?.length === 0) this.pingRequests.delete(key);
            request?.callback(null, Date.now() - request.startedAt, Buffer.from(payload));
        };
        const prevOnSettings = session.onsettings;
        // The native session sent its initial SETTINGS before transport attachment.
        this.settingsAckWaiters.unshift(undefined);
        this.pendingSettingsAck = true;
        session.onsettings = (isAck: boolean) => {
            if (typeof prevOnSettings === 'function') prevOnSettings(isAck);
            if (!isAck) {
                this._remoteSettings = { ...session.remoteSettings };
                this.emit('remoteSettings', this.remoteSettings);
                return;
            }
            this._localSettings = { ...session.localSettings };
            const waiter = this.settingsAckWaiters.shift();
            this.pendingSettingsAck = this.settingsAckWaiters.length > 0;
            waiter?.(this);
            this.emit('localSettings', this.localSettings);
        };
        const queued = this.queuedSettings;
        this.queuedSettings = [];
        for (const s of queued) this.sendSettings(s);
    }

    /** Push SETTINGS onto the wire and arm the ack flag. */
    private sendSettings(settings: Record<string, unknown>): void {
        const session = this.conn?.session;
        if (!session) {
            this.queuedSettings.push(settings);
            return;
        }
        this.pendingSettingsAck = true;
        // Validation canonicalizes custom ids before the native parser submits them.
        session.configure(settings as Parameters<typeof session.configure>[0]);
    }

    /**
     * Change SETTINGS mid-session. Validation is eager and identical to
     * getPackedSettings, so a bad value throws before anything is queued.
     */
    settings(
        settings: Record<string, unknown>,
        callback?: (err: Error | null, s: Http2Session, duration: number) => void,
    ): void {
        if (settings === null || typeof settings !== 'object') {
            throw invalidArgType('settings', 'of type object', settings);
        }
        if (callback !== undefined && typeof callback !== 'function') {
            throw invalidArgType('callback', 'of type function', callback);
        }
        if (this.destroyed) {
            throw h2Error('ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed');
        }
        const validated = this.mergeLocalSettings(settings);
        const start = Date.now();
        this.settingsAckWaiters.push(callback ? s => callback(null, s, Date.now() - start) : undefined);
        // Native configure skips empty settings; repeat the current table size
        // so every queued callback corresponds to a frame that receives an ACK.
        this.sendSettings({ ...validated, headerTableSize: this.submittedSettings.headerTableSize });
    }

    setLocalWindowSize(windowSize: number): void {
        if (typeof windowSize !== 'number') {
            throw invalidArgType('windowSize', 'of type number', windowSize);
        }
        if (!Number.isInteger(windowSize) || windowSize < 0 || windowSize > 0x7fffffff) {
            throw Object.assign(
                new RangeError(`The value of "windowSize" is out of range. Received ${windowSize}`),
                { code: 'ERR_OUT_OF_RANGE' },
            );
        }
        const session = this.conn?.session;
        if (!session) return;
        const current = typeof session.localWnd === 'number' ? session.localWnd : 0;
        const delta = windowSize - current;
        if (delta !== 0) session.wndUpdate(0, delta);
    }

    setTimeout(msecs: number, callback?: () => void): this {
        if (typeof msecs !== 'number') {
            throw invalidArgType('msecs', 'of type number', msecs);
        }
        if (callback !== undefined && typeof callback !== 'function') {
            throw invalidArgType('callback', 'of type function', callback);
        }
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        this.timeoutMs = msecs;
        if (callback) this.once('timeout', callback);
        if (msecs > 0) {
            this.timeoutTimer = setTimeout(() => {
                this.timeoutTimer = null;
                this.emit('timeout');
            }, msecs);
            // A session timeout must not by itself hold the loop open.
            (this.timeoutTimer as { unref?: () => void }).unref?.();
        }
        return this;
    }

    get timeout(): number {
        return this.timeoutMs;
    }

    ref(): this {
        (this.socket as { ref?: () => void } | null)?.ref?.();
        return this;
    }

    unref(): this {
        (this.socket as { unref?: () => void } | null)?.unref?.();
        return this;
    }

    private clearSettings(): void {
        this.queuedSettings.length = 0;
        this.settingsAckWaiters.length = 0;
        this.pendingSettingsAck = false;
    }

    private clearPingRequests(): void {
        const requests = Array.from(this.pingRequests.values()).flat();
        this.pingRequests.clear();
        if (requests.length === 0) return;
        const error = h2Error('ERR_HTTP2_PING_CANCEL', 'HTTP/2 ping was cancelled');
        // Node cancels an outstanding ping as part of session teardown: the
        // callback receives only the error and runs before the session's
        // `close` event. Do not fabricate an ACK duration/payload or defer it
        // past close; both details are observable by callers.
        for (const request of requests) Reflect.apply(request.callback, undefined, [error]);
    }

    private clearPendingStreams(error: Error): void {
        for (const stream of this.pendingStreams) stream.destroy(error);
        this.pendingStreams.clear();
    }

    close(cb?: () => void): void {
        if (this.closed) {
            if (cb) queueMicrotask(cb);
            return;
        }
        this.closed = true;
        this.clearPendingStreams(h2Error('ERR_HTTP2_GOAWAY_SESSION', 'The session has been closed'));
        this.clearSettings();
        this.clearPingRequests();
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        this.conn?.close();
        if (!this.conn) this.socket?.destroy();
        this.conn = null;
        this.emit('close');
        if (cb) queueMicrotask(cb);
    }

    destroy(error?: Error): void {
        if (this.destroyed) return;
        const wasClosed = this.closed;
        this.destroyed = true;
        this.closed = true;
        this.clearPendingStreams(error ?? h2Error('ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed'));
        this.clearSettings();
        this.clearPingRequests();
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        this.conn?.destroy();
        if (!this.conn) this.socket?.destroy();
        this.conn = null;
        if (error) this.emit('error', error);
        if (!wasClosed) this.emit('close');
    }

    ping(payload?: Buffer | Uint8Array, cb?: (err: Error | null, duration: number, payload: Buffer) => void): boolean {
        if (!this.conn) return false;
        if (payload !== undefined && (!(payload instanceof Uint8Array) || payload.byteLength !== 8)) {
            throw Object.assign(new RangeError('HTTP2 ping payload must be 8 bytes'), { code: 'ERR_HTTP2_PING_LENGTH' });
        }
        const bytes = payload === undefined ? new Uint8Array(8) : new Uint8Array(payload);
        if (cb) {
            const key = pingPayloadKey(bytes);
            let requests = this.pingRequests.get(key);
            if (!requests) {
                requests = [];
                this.pingRequests.set(key, requests);
            }
            requests.push({ startedAt: Date.now(), payload: bytes, callback: cb });
            try {
                this.conn.session.ping(bytes);
            } catch (error) {
                requests.pop();
                if (requests.length === 0) this.pingRequests.delete(key);
                throw error;
            }
        } else {
            this.conn.session.ping(bytes);
        }
        return true;
    }

    goaway(code?: number): void {
        this.conn?.session.goaway(code ?? 0);
    }
}

function pingPayloadKey(payload: Uint8Array): string {
    let key = '';
    // Native typed-array values do not necessarily expose the JS iterator.
    // Indexing also avoids allocating another view just to correlate an ACK.
    for (let index = 0; index < payload.byteLength; index++) {
        key += String.fromCharCode(payload[index]!);
    }
    return key;
}

/* ── Client session ───────────────────────────────────────────── */

export class ClientHttp2Session extends Http2Session {
    private authority = 'localhost';
    private pendingRequests = new Map<ClientHttp2Stream, { pairs: H2Header[]; end: boolean }>();

    constructor(initialSettings?: Record<string, unknown>) {
        super(constants.NGHTTP2_SESSION_CLIENT, initialSettings);
    }

    setAuthority(value: string): void {
        this.authority = value;
    }

    private readonly flushRequests = (): void => {
        for (const [stream, { pairs, end }] of this.pendingRequests) {
            this.pendingRequests.delete(stream);
            this.pendingStreams.delete(stream);
            if (stream.destroyed) continue;
            let opened;
            try {
                opened = this.openRequest(pairs, end);
            } catch (error) {
                stream.destroy(error instanceof Error ? error : new Error(String(error)));
                continue;
            }
            try {
                stream.attach(opened);
            } catch (error) {
                if (this.pendingRequests.size) queueMicrotask(this.flushRequests);
                throw error;
            }
        }
    };

    close(callback?: () => void): void {
        this.removeListener('connect', this.flushRequests);
        this.pendingRequests.clear();
        super.close(callback);
    }

    destroy(error?: Error): void {
        this.removeListener('connect', this.flushRequests);
        this.pendingRequests.clear();
        super.destroy(error);
    }

    attach(socket: Socket, secure: boolean): void {
        if (this.closed || this.destroyed) { socket.destroy(); return; }
        if (this.conn) { socket.destroy(); return; }
        this.socket = socket;
        try {
            socket.pause();
        } catch {
            /* */
        }
        const transport = takeTcpForH2(socket);
        this.conn = new H2Connection(transport, false, secure, this.initialSettings);
        this.conn.on({
            onError: err => this.destroy(err),
            onClose: () => this.close(),
        });
        this.onTransportAttached(secure);
        queueMicrotask(() => this.emit('connect', this, socket));
    }

    attachTls(tlsSocket: TLSSocket): void {
        if (this.closed || this.destroyed) { tlsSocket.destroy(); return; }
        if (this.conn) { tlsSocket.destroy(); return; }
        this.socket = tlsSocket as unknown as Socket;
        const alpn = tlsSocket.alpnProtocol;
        if (alpn && alpn !== 'h2' && alpn !== 'h2c') {
            throw h2Error(
                'ERR_HTTP2_ALPN_MISMATCH',
                `http2.connect: negotiated ALPN '${alpn}', expected h2`,
            );
        }
        const transport = takeTlsForH2(tlsSocket);
        this.conn = new H2Connection(transport, false, true, this.initialSettings);
        this.conn.on({
            onError: err => this.destroy(err),
            onClose: () => this.close(),
        });
        this.onTransportAttached(true, alpn || 'h2');
        queueMicrotask(() => this.emit('connect', this, tlsSocket));
    }

    private assertOpenForRequest(): void {
        if (this.destroyed) throw h2Error('ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed');
        if (this.closed) throw h2Error('ERR_HTTP2_GOAWAY_SESSION', 'The session has been closed');
    }

    request(
        headers: Record<string, unknown> = {},
        options?: { endStream?: boolean },
    ): ClientHttp2Stream {
        this.assertOpenForRequest();
        const pairs = toHeaderPairs(headers);
        const method = pairs.find(([name]) => name === ':method')?.[1] ?? 'GET';
        const end = options?.endStream ?? (method === 'GET' || method === 'HEAD');
        this.assertOpenForRequest();
        if (!this.conn) {
            const stream = new ClientHttp2Stream(undefined, method, this, end);
            this.pendingStreams.add(stream);
            stream.once('close', () => {
                this.pendingStreams.delete(stream);
                this.pendingRequests.delete(stream);
                if (this.pendingRequests.size === 0) this.removeListener('connect', this.flushRequests);
            });
            if (this.pendingRequests.size === 0) this.once('connect', this.flushRequests);
            this.pendingRequests.set(stream, { pairs, end });
            return stream;
        }
        return new ClientHttp2Stream(this.openRequest(pairs, end), method, this, end);
    }

    private openRequest(pairs: H2Header[], end: boolean) {
        if (!pairs.some(([n]) => n === ':method')) pairs.unshift([':method', 'GET']);
        if (!pairs.some(([n]) => n === ':path')) pairs.unshift([':path', '/']);
        if (!pairs.some(([n]) => n === ':scheme')) {
            pairs.unshift([':scheme', this.encrypted ? 'https' : 'http']);
        }
        if (!pairs.some(([n]) => n === ':authority')) {
            pairs.unshift([':authority', this.authority]);
        }
        // GET/HEAD default endStream; POST needs endStream:false then write+end
        return this.conn!.request(pairs, end);
    }
}
