/**
 * node:http2 sessions: the Http2Session base and the ClientHttp2Session that
 * attaches a cleartext or TLS transport and opens client streams.
 */

import { EventEmitter } from '../events';
import { Buffer } from '../buffer';
import { Socket } from '../net';
import type { TLSSocket } from '../tls';
import { H2Connection } from '@cnojs/http/h2';
import {
    SETTINGS_ENABLE_CONNECT_PROTOCOL,
    SETTINGS_ENABLE_PUSH,
    SETTING_NAME_TO_ID,
    constants,
} from './constants';
import { h2Error, invalidArgType } from './errors';
import { toHeaderPairs } from './headers';
import { takeTcpForH2, takeTlsForH2 } from './transport';
import { customSettingEntries, getDefaultSettings, settingsValueAsUint32 } from './settings';
import { ClientHttp2Stream } from './stream';

/* ── Session base ─────────────────────────────────────────────── */

export class Http2Session extends EventEmitter {
    protected conn: H2Connection | null = null;
    protected socket: Socket | null = null;
    closed = false;
    destroyed = false;
    type: number;
    /** Set once a transport is attached; before that Node reports undefined. */
    protected _alpnProtocol: string | false | undefined;
    protected _encrypted: boolean | undefined;
    protected _connecting = true;
    remoteSettings: Record<string, number | boolean> = {};
    localSettings: Record<string, number | boolean>;
    pendingSettingsAck = false;
    /** Settings requested before a transport existed; flushed on attach. */
    private queuedSettings: Array<Record<string, unknown>> = [];
    private settingsAckWaiters: Array<(s: Http2Session) => void> = [];
    private timeoutMs = 0;
    private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    private _originSet: string[] | undefined;

    constructor(type: number, initialSettings?: Record<string, unknown>) {
        super();
        this.type = type;
        // Node seeds localSettings from the defaults merged with what the
        // session was constructed with, not with `{}`.
        this.localSettings = getDefaultSettings();
        if (initialSettings) this.mergeLocalSettings(initialSettings);
    }

    /** Validate then fold into localSettings (throws before mutating). */
    private mergeLocalSettings(settings: Record<string, unknown>): void {
        const validated: Record<string, number | boolean> = {};
        for (const [name, raw] of Object.entries(settings)) {
            if (raw === undefined) continue;
            if (name === 'customSettings') {
                customSettingEntries(raw);
                continue;
            }
            const id = SETTING_NAME_TO_ID[name];
            if (id === undefined) continue;
            const value = settingsValueAsUint32(id, raw);
            validated[name] = (id === SETTINGS_ENABLE_PUSH || id === SETTINGS_ENABLE_CONNECT_PROTOCOL)
                ? value !== 0
                : value;
        }
        Object.assign(this.localSettings, validated);
    }

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
        const prevOnSettings = session.onsettings;
        session.onsettings = (isAck: boolean) => {
            if (typeof prevOnSettings === 'function') prevOnSettings(isAck);
            if (!isAck) return;
            this.pendingSettingsAck = false;
            const waiters = this.settingsAckWaiters;
            this.settingsAckWaiters = [];
            for (const w of waiters) w(this);
            this.emit('localSettings', this.localSettings);
        };
        // `configure` only understands the named RFC 7540 settings.
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
        this.mergeLocalSettings(settings);
        const start = Date.now();
        if (callback) {
            this.settingsAckWaiters.push(s => callback(null, s, Date.now() - start));
        }
        this.sendSettings(settings);
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

    close(cb?: () => void): void {
        if (this.closed) {
            if (cb) queueMicrotask(cb);
            return;
        }
        this.closed = true;
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        this.conn?.close();
        this.conn = null;
        this.emit('close');
        if (cb) queueMicrotask(cb);
    }

    destroy(error?: Error): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.closed = true;
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        this.conn?.destroy();
        this.conn = null;
        if (error) this.emit('error', error);
        this.emit('close');
    }

    ping(payload?: Buffer | Uint8Array, cb?: (err: Error | null, duration: number, payload: Buffer) => void): boolean {
        if (!this.conn) return false;
        const start = Date.now();
        this.conn.session.onping = (isAck, p) => {
            if (!isAck) return;
            cb?.(null, Date.now() - start, Buffer.from(p));
        };
        this.conn.session.ping(payload instanceof Uint8Array ? payload : undefined);
        return true;
    }

    goaway(code?: number): void {
        this.conn?.session.goaway(code ?? 0);
    }
}

/* ── Client session ───────────────────────────────────────────── */

export class ClientHttp2Session extends Http2Session {
    private authority = 'localhost';

    constructor(initialSettings?: Record<string, unknown>) {
        super(constants.NGHTTP2_SESSION_CLIENT, initialSettings);
    }

    setAuthority(value: string): void {
        this.authority = value;
    }

    attach(socket: Socket, secure: boolean): void {
        this.socket = socket;
        try {
            socket.pause();
        } catch {
            /* */
        }
        const transport = takeTcpForH2(socket);
        this.conn = new H2Connection(transport, false, secure);
        this.conn.on({
            onError: err => this.emit('error', err),
            onClose: () => this.close(),
        });
        this.onTransportAttached(secure);
        queueMicrotask(() => this.emit('connect', this, socket));
    }

    attachTls(tlsSocket: TLSSocket): void {
        this.socket = tlsSocket as unknown as Socket;
        const alpn = tlsSocket.alpnProtocol;
        if (alpn && alpn !== 'h2' && alpn !== 'h2c') {
            throw h2Error(
                'ERR_HTTP2_ALPN_MISMATCH',
                `http2.connect: negotiated ALPN '${alpn}', expected h2`,
            );
        }
        const transport = takeTlsForH2(tlsSocket);
        this.conn = new H2Connection(transport, false, true);
        this.conn.on({
            onError: err => this.emit('error', err),
            onClose: () => this.close(),
        });
        this.onTransportAttached(true, alpn || 'h2');
        queueMicrotask(() => this.emit('connect', this, tlsSocket));
    }

    request(
        headers: Record<string, unknown>,
        options?: { endStream?: boolean },
    ): ClientHttp2Stream {
        if (!this.conn) {
            throw h2Error('ERR_HTTP2_INVALID_SESSION', 'HTTP/2 session is not connected');
        }
        const pairs = toHeaderPairs(headers);
        const method = pairs.find(([n]) => n === ':method')?.[1] ?? 'GET';
        if (!pairs.some(([n]) => n === ':method')) pairs.unshift([':method', method]);
        if (!pairs.some(([n]) => n === ':path')) pairs.push([':path', '/']);
        if (!pairs.some(([n]) => n === ':scheme')) {
            pairs.push([':scheme', this.encrypted ? 'https' : 'http']);
        }
        if (!pairs.some(([n]) => n === ':authority')) {
            pairs.push([':authority', this.authority]);
        }
        // GET/HEAD default endStream; POST needs endStream:false then write+end
        const end = options?.endStream ?? (method === 'GET' || method === 'HEAD');
        const h2s = this.conn.request(pairs, end);
        return new ClientHttp2Stream(h2s, method);
    }
}
