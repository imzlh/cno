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

type ClipboardWriteItem = unknown;
type NavigatorShareData = {
    title?: string;
    text?: string;
    url?: string;
    files?: readonly unknown[];
};
type ImplementedNavigator = Omit<Navigator, 'gpu'>;

class BatteryManagerImpl extends EventTarget implements BatteryManager {
    readonly charging: boolean = true;
    readonly chargingTime: number = 0;
    readonly dischargingTime: number = Infinity;
    readonly level: number = 1;
    onchange: EventListener | null = null;
}

class ClipboardImpl {
    #text = '';

    async readText(): Promise<string> {
        return this.#text;
    }

    async writeText(text: string): Promise<void> {
        this.#text = String(text);
    }

    async read(): Promise<never> {
        throw new DOMException('Clipboard.read() is not supported in this environment', 'NotSupportedError');
    }

    async write(_items: readonly ClipboardWriteItem[]): Promise<never> {
        throw new DOMException('Clipboard.write() is not supported in this environment', 'NotSupportedError');
    }
}

class NavigatorUADataImpl implements NavigatorUAData {
    readonly brands: NavigatorUABrandVersion[];
    readonly mobile = false;
    readonly platform: string;

    constructor(platform: string, version: string) {
        this.platform = platform;
        this.brands = [{ brand: 'cno', version }];
    }

    async getHighEntropyValues(hints: string[]): Promise<UADataValues> {
        const result: UADataValues = this.toJSON();
        for (const hint of hints) {
            if (hint === 'fullVersionList') {
                Reflect.set(result, 'fullVersionList', this.brands);
            }
        }
        return result;
    }

    toJSON(): UALowEntropyJSON {
        return {
            brands: this.brands,
            mobile: this.mobile,
            platform: this.platform,
        };
    }
}

class NavigatorImpl implements ImplementedNavigator {
    private _core: NavigatorCoreImpl;
    private _permissions: ReturnType<typeof createPermissions>;
    private _storage: ReturnType<typeof createStorageManager>;
    private _networkInfo: ReturnType<typeof createNetworkInformation>;
    private _opensocket: ReturnType<typeof createDirectSockets>;
    private _battery: BatteryManager | null = null;
    private _clipboard = new ClipboardImpl();
    private _userAgentData: NavigatorUAData;

    constructor() {
        this._core = new NavigatorCoreImpl();
        this._permissions = createPermissions();
        this._storage = createStorageManager();
        this._networkInfo = createNetworkInformation();
        this._opensocket = createDirectSockets();
        this._userAgentData = new NavigatorUADataImpl(this._core.platform, this._core.appVersion);
    }

    get gpu(): undefined {
        return undefined;
    }

    get platform(): string {
        return this._core.platform;
    }

    get userAgent(): string {
        return this._core.userAgent;
    }

    get userAgentData(): NavigatorUAData {
        return this._userAgentData;
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
        let interfaces: ReturnType<typeof os.networkInterfaces>;
        try {
            interfaces = os.networkInterfaces();
        } catch {
            return false;
        }
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

    get clipboard() {
        return this._clipboard;
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

    canShare(data?: NavigatorShareData): boolean {
        return false;
    }

    async share(data: NavigatorShareData): Promise<void> {
        throw new DOMException('Web Share API is not supported in this environment', 'NotSupportedError');
    }
}

const navigator = new NavigatorImpl();

function NavigatorCtor(): never {
    throw new TypeError('Illegal constructor');
}
NavigatorCtor.prototype = NavigatorImpl.prototype;

function NavigatorUADataCtor(): never {
    throw new TypeError('Illegal constructor');
}
NavigatorUADataCtor.prototype = NavigatorUADataImpl.prototype;

Object.defineProperty(globalThis, 'navigator', {
    value: navigator,
    writable: false,
    enumerable: true,
    configurable: true,
});
Object.defineProperty(globalThis, 'Navigator', {
    value: NavigatorCtor,
    writable: true,
    enumerable: false,
    configurable: true,
});
Object.defineProperty(globalThis, 'NavigatorUAData', {
    value: NavigatorUADataCtor,
    writable: true,
    enumerable: false,
    configurable: true,
});

export { NavigatorImpl };
