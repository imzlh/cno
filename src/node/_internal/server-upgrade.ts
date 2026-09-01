import { Socket, type UpgradeHandle } from '../net';

import type { HttpResponse } from '@cnojs/http/server';
import type { IncomingRequestTarget } from './server-request-stream';

export interface UpgradeEmitter {
    listenerCount(event: string | symbol): number;
    emit(event: 'upgrade', request: IncomingRequestTarget, socket: Socket, head: Uint8Array): boolean;
    emit(event: 'error', error: unknown): boolean;
}

export interface UpgradeResult {
    handled: boolean;
    upgraded: boolean;
}

export function isUpgradeRequest(incoming: IncomingRequestTarget): boolean {
    const connectionHeader = String(incoming.headers['connection'] ?? '').toLowerCase();
    return connectionHeader.split(',').some((token) => token.trim() === 'upgrade')
        && incoming.headers['upgrade'] !== undefined;
}

export function emitNodeServerUpgrade(
    emitter: UpgradeEmitter,
    response: HttpResponse,
    incoming: IncomingRequestTarget,
): UpgradeResult {
    if (!isUpgradeRequest(incoming) || emitter.listenerCount('upgrade') <= 0) {
        return { handled: false, upgraded: false };
    }

    let upgraded = false;
    let upgradeSocket: Socket | null = null;
    try {
        const handle = (response as HttpResponse & { upgrade(): UpgradeHandle }).upgrade();
        upgraded = true;
        upgradeSocket = Socket.fromUpgradeHandle(handle);
        // Node passes any already-buffered post-header bytes as `head`.
        // The core handle replays them through the read pump, so we
        // pass an empty head to avoid double-delivery.
        emitter.emit('upgrade', incoming, upgradeSocket, new Uint8Array(0));
    } catch (err) {
        // Once upgrade() succeeds, ownership has moved to the Node socket. If
        // the listener throws before retaining it, close that transport here.
        if (upgradeSocket && !upgradeSocket.destroyed) upgradeSocket.destroy();
        emitter.emit('error', err);
    }

    return { handled: true, upgraded };
}
