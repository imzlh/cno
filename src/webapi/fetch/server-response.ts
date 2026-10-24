/**
 * `fetch/response.ts` internals other layers reach for: kept out of webapi/fetch
 * so `Deno.serve` does not pull in curl, XHR and the HTTP/1 parser.
 */
import { Response, getResponseInitiatorCallFrames, setResponseInitiatorCallFrames } from "./response";

/** The 101 Switching Protocols response handed to a WebSocket upgrade. */
export function createSwitchingProtocolsResponse(init: ResponseInit): Response {
    return Response.switchingProtocols(init);
}

export { getResponseInitiatorCallFrames, setResponseInitiatorCallFrames };
