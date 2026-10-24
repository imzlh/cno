/**
 * Built-in diagnostics channels that core modules publish to. They live here so
 * channel identity is shared, and must not surface on `node:diagnostics_channel`.
 * Every publish site MUST be guarded by `hasSubscribers` to stay allocation-free.
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
 * True when any of the four http-client channels has a subscriber, so the
 * per-request `emit` interception is installed only when needed.
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
 * Publish `http.client.request.error` / `http.client.response.finish` before
 * the user-visible event. The client internals are out of reach, so `emit` is
 * shadowed rather than a listener added: an 'error' listener would swallow
 * otherwise-unhandled errors.
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
