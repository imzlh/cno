import type { NetworkInformation } from './types';
import { EventTarget, Event } from '../events';

const os = import.meta.use('os');

class NetworkInformationImpl extends EventTarget implements NetworkInformation {
    private _onchange: EventListener | null = null;

    get effectiveType(): '4g' | '3g' | '2g' | 'slow-2g' {
        return '4g';
    }

    get downlink(): number {
        return 10;
    }

    get downlinkMax(): number {
        return 100;
    }

    get rtt(): number {
        return 50;
    }

    get saveData(): boolean {
        return false;
    }

    get type(): 'bluetooth' | 'cellular' | 'ethernet' | 'none' | 'wifi' | 'wimax' | 'other' | 'unknown' {
        const interfaces = os.networkInterfaces();
        for (const iface of interfaces) {
            if (!iface.internal) {
                if (iface.name.startsWith('wlan') || iface.name.startsWith('wifi')) {
                    return 'wifi';
                }
                if (iface.name.startsWith('eth') || iface.name.startsWith('en')) {
                    return 'ethernet';
                }
                if (iface.name.startsWith('rmnet') || iface.name.startsWith('wwan')) {
                    return 'cellular';
                }
            }
        }
        return 'unknown';
    }

    get onchange(): EventListener | null {
        return this._onchange;
    }

    set onchange(listener: EventListener | null) {
        this._onchange = listener;
    }
}

class NavigatorOnLineImpl {
    private _networkInfo: NetworkInformationImpl;

    constructor(networkInfo: NetworkInformationImpl) {
        this._networkInfo = networkInfo;
    }

    get onLine(): boolean {
        const interfaces = os.networkInterfaces();
        for (const iface of interfaces) {
            if (!iface.internal && iface.address) {
                return true;
            }
        }
        return false;
    }

    get connection(): NetworkInformation {
        return this._networkInfo;
    }
}

export function createNetworkInformation(): NetworkInformation {
    return new NetworkInformationImpl();
}

export function createNavigatorOnLine(networkInfo: NetworkInformation) {
    return new NavigatorOnLineImpl(networkInfo as NetworkInformationImpl);
}
