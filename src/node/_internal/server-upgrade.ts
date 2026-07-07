import { Socket, type UpgradeHandle } from '../net';

import type { HttpResponse } from '@cnojs/http/server';
import type { IncomingMessageImpl } from '../http/server';

export interface UpgradeEmitter {
    listenerCount(event: string | symbol): number;
    emit(event: 'upgrade', request: IncomingMessageImpl, socket: Socket, head: Uint8Array): boolean;
    emit(event: 'error', error: unknown): boolean;
}

export function isUpgradeRequest(incoming: IncomingMessageImpl): boolean {
    const connectionHeader = String(incoming.headers['connection'] ?? '').toLowerCase();
    return connectionHeader.split(',').some((token) => token.trim() === 'upgrade')
        && incoming.headers['upgrade'] !== undefined;
}

export function emitNodeServerUpgrade(
    emitter: UpgradeEmitter,
    response: HttpResponse,
    incoming: IncomingMessageImpl,
): boolean {
    if (!isUpgradeRequest(incoming) || emitter.listenerCount('upgrade') <= 0) return false;

    try {
        const handle = (response as HttpResponse & { upgrade(): UpgradeHandle }).upgrade();
        const upgradeSocket = Socket.fromUpgradeHandle(handle);
        // Node passes any already-buffered post-header bytes as `head`.
        // The core handle replays them through the read pump, so we
        // pass an empty head to avoid double-delivery.
        emitter.emit('upgrade', incoming, upgradeSocket, new Uint8Array(0));
    } catch (err) {
        emitter.emit('error', err);
    }

    return true;
}
