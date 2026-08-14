/**
 * node:tls SecureContext — the SSL_CTX wrapper, the JS-stream adapter the
 * TLSSocket handle points at, and the merge that decides which material and
 * which verify decision a connection actually runs with.
 */

import { Duplex } from '../stream';
import { certInputToString, effectiveDefaultCACertificates, keyInputToString, normalizeAlpnProtocols } from './_shared';
import type { InternalSecureContextOptions, InternalSocketHandle, SecureContextOptions } from './types';

const ssl = import.meta.use('ssl');

export class JSStreamSocketWrapper extends Duplex {
    _stream: Duplex | null;
    _handle: InternalSocketHandle;
    encrypted = false;

    constructor(stream?: Duplex) {
        super({ allowHalfOpen: false });
        this._stream = stream ?? null;
        this._handle = {
            close() {},
            getpeername(out: Record<string, unknown>) {
                out.family = undefined;
                out.address = undefined;
                out.port = undefined;
            },
        };

        if (stream) {
            stream.on('data', (chunk: unknown) => this.push(chunk));
            stream.on('end', () => this.push(null));
            stream.on('error', (error: Error) => this.emit('error', error));
            stream.on('close', () => this.emit('close'));
        }
    }

    _read(_size: number): void {
        this._stream?.resume?.();
    }

    _write(chunk: unknown, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this._stream) {
            callback();
            return;
        }
        this._stream.write(chunk, encoding, callback);
    }

    _final(callback: (error?: Error | null) => void): void {
        if (!this._stream) {
            callback();
            return;
        }
        this._stream.end(callback);
    }

    destroy(error?: Error): this {
        this._stream?.destroy(error);
        return super.destroy(error);
    }
}

// SecureContext

export class SecureContext {
    #context: CModuleSSL.Context;
    /**
     * The options this context was built from.
     *
     * `verify` / `verifyHostname` are per-connection decisions (they track
     * `rejectUnauthorized` and `checkServerIdentity`) but the C layer stores them
     * on the SSL_CTX, so a context built by `tls.createSecureContext()` cannot
     * carry them. `tls.connect` therefore has to rebuild a context that combines
     * the caller's material with the connection's verify decision — it needs the
     * original options to do that, because the C context exposes no way to read
     * the PEM back out or to change the verify mode after construction.
     */
    readonly sourceOptions: InternalSecureContextOptions | undefined;

    constructor(options?: InternalSecureContextOptions) {
        const opts: CModuleSSL.ContextOptions = {};
        this.sourceOptions = options;

        if (options?.mode) opts.mode = options.mode;
        if (options?.key) {
            const k = Array.isArray(options.key) ? options.key[0] : options.key;
            opts.key = keyInputToString(k);
        }
        if (options?.cert) {
            const c = Array.isArray(options.cert) ? options.cert[0] : options.cert;
            opts.cert = certInputToString(c);
        }
        if (options?.ca) {
            const ca = Array.isArray(options.ca) ? options.ca : [options.ca];
            opts.ca = ca.map(c => certInputToString(c)).filter(value => value !== undefined).join('\n');
        } else {
            // effectiveDefaultCACertificates() falls back to the platform trust
            // store. Reading the bare `defaultCACertificates` here meant the
            // store was never consulted unless the caller had first called
            // setDefaultCACertificates(), so `verify: true` had no trust
            // anchors at all and failed closed against every public server.
            const defaults = effectiveDefaultCACertificates();
            if (defaults.length > 0) opts.ca = defaults.join('\n');
        }
        if (options?.ciphers) opts.ciphers = options.ciphers;
        if (options?.minVersion) opts.minVersion = options.minVersion;
        if (options?.maxVersion) opts.maxVersion = options.maxVersion;
        if (options?.dhparam) opts.dhparam = options.dhparam;
        if (options?.ecdhCurve) opts.ecdhCurve = options.ecdhCurve;
        if (options?.verify !== undefined) opts.verify = options.verify;
        if (options?.verifyHostname !== undefined) opts.verifyHostname = options.verifyHostname;
        const alpn = options?.alpn ?? normalizeAlpnProtocols(options?.ALPNProtocols);
        if (alpn) opts.alpn = alpn;

        this.#context = new ssl.Context(opts);
    }

    get context(): CModuleSSL.Context { return this.#context; }
}

/**
 * Build the effective context for a connection, honouring a caller-supplied
 * `secureContext`.
 *
 * `tls.connect` used to build its own context unconditionally and never read
 * `options.secureContext`, so everything the caller configured through
 * `tls.createSecureContext()` was silently discarded. That lost the caller's CA
 * (a correct private CA reported UNABLE_TO_GET_ISSUER_CERT_LOCALLY) and — the
 * security half — it also lost `minVersion`, so a client pinned to TLSv1.3 via a
 * secureContext silently completed a TLSv1.2 handshake where Node refuses with
 * ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION.
 *
 * The caller's context object cannot be used as-is: `verify`/`verifyHostname`
 * live on the SSL_CTX and a context from `createSecureContext()` has neither, so
 * reusing it would drop peer verification entirely and turn a fail-closed bug
 * into a fail-open one. Rebuild instead, with the caller's material as the base
 * and this connection's mode and verify decision applied on top.
 *
 * Node's precedence is that a supplied secureContext provides the context-level
 * material and the sibling top-level options (ca/cert/key/ciphers/minVersion/…)
 * are ignored, which is what taking `sourceOptions` as the base reproduces.
 */
export function mergeSuppliedSecureContext(
    supplied: SecureContext | undefined,
    computed: InternalSecureContextOptions,
): SecureContext {
    if (!supplied) return new SecureContext(computed);
    const base = supplied.sourceOptions;
    // A context we cannot introspect (constructed elsewhere) is still better
    // used than silently ignored, but it must not lose verification: fall back
    // to the computed options in that case.
    if (!base) return new SecureContext(computed);
    return new SecureContext({
        ...base,
        // mode and the verify decision belong to this connection, not to the
        // stored context — initTLSSocket builds server sockets through here too.
        mode: computed.mode,
        verify: computed.verify,
        verifyHostname: computed.verifyHostname,
        // ALPN is negotiated per connection, so a list passed to connect() still
        // applies when the context did not carry one.
        alpn: base.alpn ?? computed.alpn,
    });
}

export function createSecureContext(options?: SecureContextOptions): SecureContext {
    return new SecureContext(options);
}
