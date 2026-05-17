/**
 * Node.js http module
 */

export { STATUS_CODES, METHODS } from './server';
export { 
    IncomingMessageImpl,
    OutgoingMessageImpl,
    ServerResponseImpl,
    ServerImpl,
    createServer,
    validateHeaderName,
    validateHeaderValue,
} from './server';
export { 
    ClientRequestImpl,
    Agent,
    globalAgent,
    request,
    get,
} from './client';

import { STATUS_CODES, METHODS } from './server';
import { createServer, ServerImpl, IncomingMessageImpl, ServerResponseImpl, OutgoingMessageImpl } from './server';
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
};