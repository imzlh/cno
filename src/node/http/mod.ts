/**
 * Node.js http module
 */

export { STATUS_CODES, METHODS } from './server';
export { 
    IncomingMessageImpl as IncomingMessage,
    OutgoingMessageImpl as OutgoingMessage,
    ServerResponseImpl as ServerResponse,
    ServerImpl as Server,
    createServer,
    validateHeaderName,
    validateHeaderValue,
} from './server';
export { 
    ClientRequestImpl as ClientRequest,
    Agent,
    globalAgent,
    request,
    get,
} from './client';

import { STATUS_CODES, METHODS } from './server';
import { createServer, ServerImpl, IncomingMessageImpl, ServerResponseImpl, OutgoingMessageImpl, validateHeaderName, validateHeaderValue } from './server';
import { Agent, globalAgent, request, get, ClientRequestImpl } from './client';

export default {
    METHODS,
    STATUS_CODES,
    IncomingMessage: IncomingMessageImpl,
    OutgoingMessage: OutgoingMessageImpl,
    ServerResponse: ServerResponseImpl,
    Server: ServerImpl,
    ClientRequest: ClientRequestImpl,
    Agent,
    globalAgent,
    createServer,
    request,
    get,
    validateHeaderName,
    validateHeaderValue,
};
