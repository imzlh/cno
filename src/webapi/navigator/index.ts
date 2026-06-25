import type { BatteryManager } from './types';
import { NavigatorCoreImpl } from './core';
import { createPermissions } from './permissions';
import { createStorageManager } from './storage';
import { createNetworkInformation } from './connection';
import { createDirectSockets } from './sockets';
import { DOMException, EventTarget } from '../events';
import { LockManager } from '../lock';

const os = import.meta.use('os');
const _lockManager = new LockManager();

class BatteryManagerImpl extends EventTarget implements BatteryManager {
    readonly charging: boolean = true;
    readonly chargingTime: number = 0;
    readonly dischargingTime: number = Infinity;
    readonly level: number = 1;
    onchange: EventListener | null = null;
}

class NavigatorImpl implements Navigator {
    private _core: NavigatorCoreImpl;
    private _permissions: ReturnType<typeof createPermissions>;
    private _storage: ReturnType<typeof createStorageManager>;
    private _networkInfo: ReturnType<typeof createNetworkInformation>;
    private _opensocket: ReturnType<typeof createDirectSockets>;
    private _battery: BatteryManager | null = null;

    constructor() {
        this._core = new NavigatorCoreImpl();
        this._permissions = createPermissions();
        this._storage = createStorageManager();
        this._networkInfo = createNetworkInformation();
        this._opensocket = createDirectSockets();
    }

    get gpu(): never {
        throw new DOMException('Not implemented', 'DOMException');
    }

    get platform(): string {
        return this._core.platform;
    }

    get userAgent(): string {
        return this._core.userAgent;
    }

    get vendor(): string {
        return this._core.vendor;
    }

    get appName(): string {
        return this._core.appName;
    }

    get appVersion(): string {
        return this._core.appVersion;
    }

    get language(): string {
        return this._core.language;
    }

    get languages(): string[] {
        return this._core.languages;
    }

    get hardwareConcurrency(): number {
        return this._core.hardwareConcurrency;
    }

    get deviceMemory(): number {
        return this._core.deviceMemory;
    }

    get cookieEnabled(): boolean {
        return this._core.cookieEnabled;
    }

    get product(): string {
        return this._core.product;
    }

    get productSub(): string {
        return this._core.productSub;
    }

    get vendorSub(): string {
        return this._core.vendorSub;
    }

    get pdfViewerEnabled(): boolean {
        return false;
    }

    javaEnabled(): boolean {
        return this._core.javaEnabled();
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

    get connection() {
        return this._networkInfo;
    }

    get permissions() {
        return this._permissions;
    }

    get storage() {
        return this._storage;
    }

    get opensocket() {
        return this._opensocket;
    }

    get locks(): LockManager {
        return _lockManager;
    }

    async getBattery(): Promise<BatteryManager> {
        if (!this._battery) {
            this._battery = new BatteryManagerImpl();
        }
        return this._battery;
    }

    sendBeacon(url: string, data?: BodyInit): boolean {
        try {
            const fetchOptions: RequestInit = {
                method: 'POST',
                keepalive: true,
            };
            if (data) {
                fetchOptions.body = data;
            }
            fetch(url, fetchOptions).catch(() => {});
            return true;
        } catch {
            return false;
        }
    }

    vibrate(pattern: number | number[]): boolean {
        return false;
    }

    canShare(data?: any): boolean {
        return false;
    }

    async share(data: any): Promise<void> {
        throw new DOMException('Web Share API is not supported in this environment', 'NotSupportedError');
    }
}

const navigator = new NavigatorImpl();

Object.defineProperty(globalThis, 'navigator', {
    value: navigator,
    writable: false,
    enumerable: true,
    configurable: true,
});

export { NavigatorImpl };
