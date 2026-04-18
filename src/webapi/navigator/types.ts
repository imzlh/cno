export interface NetworkInformation extends EventTarget {
    readonly effectiveType: '4g' | '3g' | '2g' | 'slow-2g';
    readonly downlink: number;
    readonly downlinkMax: number;
    readonly rtt: number;
    readonly saveData: boolean;
    readonly type: 'bluetooth' | 'cellular' | 'ethernet' | 'none' | 'wifi' | 'wimax' | 'other' | 'unknown';
    onchange: EventListener | null;
}

export interface PermissionDescriptor {
    name: PermissionName;
}

export type PermissionName =
    | 'geolocation'
    | 'notifications'
    | 'push'
    | 'midi'
    | 'camera'
    | 'microphone'
    | 'speaker'
    | 'device-info'
    | 'background-sync'
    | 'bluetooth'
    | 'persistent-storage'
    | 'ambient-light-sensor'
    | 'accelerometer'
    | 'gyroscope'
    | 'magnetometer'
    | 'clipboard-read'
    | 'clipboard-write'
    | 'payment-handler'
    | 'idle-detection'
    | 'screen-wake-lock'
    | 'window-management'
    | 'local-fonts';

export interface PermissionStatus extends EventTarget {
    readonly name: PermissionName;
    readonly state: string;
    onchange: EventListener | null;
}

export interface Permissions {
    query(permissionDescriptor: PermissionDescriptor): Promise<PermissionStatus>;
}

export interface StorageEstimate {
    usage: number;
    quota: number;
    usageDetails?: Record<string, number>;
}

export interface StorageManager {
    estimate(): Promise<StorageEstimate>;
    persist(): Promise<boolean>;
    persisted(): Promise<boolean>;
}

export interface BatteryManager extends EventTarget {
    readonly charging: boolean;
    readonly chargingTime: number;
    readonly dischargingTime: number;
    readonly level: number;
    onchange: EventListener | null;
}

export interface SocketOptions {
    localAddress?: string;
    localPort?: number;
    remoteAddress?: string;
    remotePort?: number;
    keepAlive?: boolean;
    noDelay?: boolean;
}

export interface TCPSocket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
}

export interface UDPSocket {
    readonly readable: ReadableStream<UDPMessage>;
    readonly writable: WritableStream<UDPMessage>;
    readonly closed: Promise<void>;
    close(): Promise<void>;
}

export interface UDPMessage {
    data: Uint8Array;
    remoteAddress: string;
    remotePort: number;
}

export interface DirectSockets {
    openTCPSocket(options: SocketOptions): Promise<TCPSocket>;
    openUDPSocket(options: SocketOptions): Promise<UDPSocket>;
}

export interface NavigatorDirectSockets {
    opensocket: DirectSockets;
}
