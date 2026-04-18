import type { PermissionDescriptor, PermissionName, PermissionStatus, Permissions } from './types';
import { EventTarget, Event } from '../events';

const defaultPermissions: Record<PermissionName, string> = {
    'geolocation': 'prompt',
    'notifications': 'prompt',
    'push': 'prompt',
    'midi': 'prompt',
    'camera': 'prompt',
    'microphone': 'prompt',
    'speaker': 'prompt',
    'device-info': 'prompt',
    'background-sync': 'prompt',
    'bluetooth': 'prompt',
    'persistent-storage': 'prompt',
    'ambient-light-sensor': 'prompt',
    'accelerometer': 'prompt',
    'gyroscope': 'prompt',
    'magnetometer': 'prompt',
    'clipboard-read': 'prompt',
    'clipboard-write': 'prompt',
    'payment-handler': 'prompt',
    'idle-detection': 'prompt',
    'screen-wake-lock': 'prompt',
    'window-management': 'prompt',
    'local-fonts': 'prompt',
};

const grantedPermissions: Set<PermissionName> = new Set([
    'persistent-storage',
    'clipboard-read',
    'clipboard-write',
    'background-sync',
]);

class PermissionStatusImpl extends EventTarget implements PermissionStatus {
    readonly name: PermissionName;
    private _state: string;
    onchange: EventListener | null = null;

    constructor(name: PermissionName, state: string) {
        super();
        this.name = name;
        this._state = state;
    }

    get state(): string {
        return this._state;
    }

    setState(state: string): void {
        if (this._state !== state) {
            this._state = state;
            if (this.onchange) {
                this.onchange(new Event('change'));
            }
            this.dispatchEvent(new Event('change'));
        }
    }
}

class PermissionsImpl implements Permissions {
    private _statuses: Map<string, PermissionStatusImpl> = new Map();

    async query(permissionDescriptor: PermissionDescriptor): Promise<PermissionStatus> {
        const name = permissionDescriptor.name;
        const key = name;

        let status = this._statuses.get(key);
        if (status) {
            return status;
        }

        let state: string = defaultPermissions[name] || 'prompt';
        if (grantedPermissions.has(name)) {
            state = 'granted';
        }

        status = new PermissionStatusImpl(name, state);
        this._statuses.set(key, status);
        return status;
    }
}

export function createPermissions(): Permissions {
    return new PermissionsImpl();
}

export { PermissionStatusImpl };
