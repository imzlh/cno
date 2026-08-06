/**
 * Built-in diagnostics channels that core modules publish to.
 *
 * These are the exact channel names Node core creates and publishes to (verified
 * against Node v24.18.0 `_http_client.js` / `_http_server.js` / `net.js`). They
 * live here rather than in each owning module so that the channel *identity* is
 * shared: `require('diagnostics_channel').channel('http.client.request.start')`
 * must return the very same Channel object a publisher holds, otherwise a
 * subscriber never sees anything.
 *
 * NOT exported from `node:diagnostics_channel`'s public surface — Node does not
 * expose a `builtinChannels`, and adding one would be an API divergence. This
 * module is imported directly by http/https/net.
 *
 * Every publish site MUST be guarded by `channel.hasSubscribers` so the
 * uninstrumented path stays allocation-free, exactly as Node does it.
 */
import { channel } from './mod';
import type { Channel } from './mod';

// --- http client ----------------------------------------------------------
/** Published at the end of the ClientRequest constructor. `{ request }` */
export const onClientRequestCreated: Channel = channel('http.client.request.created');
/** Published from ClientRequest._finish(), i.e. on end(). `{ request }` */
export const onClientRequestStart: Channel = channel('http.client.request.start');
/** Published immediately BEFORE `request.emit('error')`. `{ request, error }` */
export const onClientRequestError: Channel = channel('http.client.request.error');
/** Published when response headers are parsed, BEFORE `emit('response')`. `{ request, response }` */
export const onClientResponseFinish: Channel = channel('http.client.response.finish');

// --- http server ----------------------------------------------------------
/** Published in the ServerResponse constructor. `{ request, response }` */
export const onServerResponseCreated: Channel = channel('http.server.response.created');
/** Published just before the request listener runs. `{ request, response, socket, server }` */
export const onServerRequestStart: Channel = channel('http.server.request.start');
/** Published from the response 'finish' handler. `{ request, response, socket, server }` */
export const onServerResponseFinish: Channel = channel('http.server.response.finish');

// --- net ------------------------------------------------------------------
/** Published at the top of Socket.prototype.connect, before connecting. `{ socket }` */
export const onNetClientSocket: Channel = channel('net.client.socket');
/** Published right after the server emits 'connection'. `{ socket }` */
export const onNetServerSocket: Channel = channel('net.server.socket');

/**
 * True when any of the four http-client channels has a subscriber.
 *
 * Used to decide whether to install the per-request `emit` interception at all,
 * so a request made with nothing subscribed pays only this boolean read.
 */
export function anyClientChannelActive(): boolean {
    return onClientRequestCreated.hasSubscribers
        || onClientRequestStart.hasSubscribers
        || onClientRequestError.hasSubscribers
        || onClientResponseFinish.hasSubscribers;
}

type EmittingRequest = {
    emit(event: string | symbol, ...args: unknown[]): boolean;
};

const instrumented = new WeakSet<object>();

/**
 * Publish `http.client.request.error` / `http.client.response.finish` for one
 * ClientRequest.
 *
 * Node publishes both from inside core, *before* the corresponding user-visible
 * event is emitted (`emitErrorEvent` publishes then calls `request.emit('error')`;
 * `parserOnIncomingClient` publishes then calls `req.emit('response')`). cno's
 * client internals live in `_internal/http-client.ts`, which is shared with
 * https and out of this module's reach, so instead of adding listeners we shadow
 * `emit` on the instance and publish on the way through.
 *
 * A listener would have been wrong for 'error' specifically: attaching one turns
 * an otherwise-unhandled 'error' into a silently swallowed one, because
 * EventEmitter only throws when the listener count is zero. Shadowing `emit`
 * leaves the listener count — and therefore the throw-on-unhandled behaviour —
 * exactly as it was.
 */
export function instrumentClientRequest(request: EmittingRequest): void {
    if (instrumented.has(request)) return;
    instrumented.add(request);

    const inner = request.emit.bind(request);
    Object.defineProperty(request, 'emit', {
        value: function emit(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
            if (event === 'error' && onClientRequestError.hasSubscribers) {
                onClientRequestError.publish({ request, error: args[0] });
            } else if (event === 'response' && onClientResponseFinish.hasSubscribers) {
                onClientResponseFinish.publish({ request, response: args[0] });
            }
            return inner(event, ...args);
        },
        writable: true,
        enumerable: false,
        configurable: true,
    });
}
