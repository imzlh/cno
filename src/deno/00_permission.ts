const permissionToken = Symbol('Deno.permission');
const permissionNames = new Set(['run', 'read', 'write', 'net', 'env', 'sys', 'ffi', 'import']);
const sysKinds = new Set([
    'loadavg',
    'hostname',
    'systemMemoryInfo',
    'networkInterfaces',
    'osRelease',
    'osUptime',
    'uid',
    'gid',
    'username',
    'cpus',
    'homedir',
    'statfs',
    'getPriority',
    'setPriority',
    'ca',
]);

function stringOrUrlKey(value: unknown): string {
    if (value instanceof URL) return value.href;
    return value === undefined ? '' : String(value);
}

function validateHost(host: unknown): string {
    if (host === undefined) return '';
    const value = String(host);
    if (value === '' || value.startsWith(':')) throw new URIError(`Invalid host: ${value}`);
    try {
        new URL(`http://${value}`);
    } catch {
        throw new URIError(`Invalid host: ${value}`);
    }
    return value;
}

function descriptorKey(desc: unknown): string {
    const record = desc && typeof desc === 'object' ? desc : {};
    const name = Reflect.get(record, 'name');
    if (typeof name !== 'string' || !permissionNames.has(name)) {
        throw new TypeError(`"${String(name)}" is not a valid permission name`);
    }

    switch (name) {
        case 'run':
            return `${name}:${stringOrUrlKey(Reflect.get(record, 'command'))}`;
        case 'read':
        case 'write':
        case 'ffi':
            return `${name}:${stringOrUrlKey(Reflect.get(record, 'path'))}`;
        case 'net':
        case 'import':
            return `${name}:${validateHost(Reflect.get(record, 'host'))}`;
        case 'env':
            {
                const variable = Reflect.get(record, 'variable');
                return `${name}:${variable === undefined ? '' : String(variable)}`;
            }
        case 'sys':
            {
                const kind = Reflect.get(record, 'kind');
                if (kind !== undefined && (typeof kind !== 'string' || !sysKinds.has(kind))) {
                    throw new TypeError(`"${String(kind)}" is not a valid sys permission kind`);
                }
                return `${name}:${kind ?? ''}`;
            }
        default:
            throw new TypeError(`"${name}" is not a valid permission name`);
    }
}

class PermissionStatus extends EventTarget implements Deno.PermissionStatus {
    public onchange: ((this: Deno.PermissionStatus, ev: Event) => unknown) | null = null;
    public state: Deno.PermissionState = 'granted';
    public partial: boolean = false;

    constructor(token: symbol | undefined = undefined) {
        if (token !== permissionToken) throw new TypeError('Illegal constructor');
        super();
    }

    dispatchEvent(event: Event): boolean {
        const result = super.dispatchEvent(event);
        if (event.type === 'change' && this.onchange) {
            this.onchange.call(this, event);
        }
        return result;
    }

    get [Symbol.toStringTag]() {
        return 'PermissionStatus';
    }
}

class Permissions implements Deno.Permissions {
    #statuses = new Map<string, PermissionStatus>();

    constructor(token: symbol | undefined = undefined) {
        if (token !== permissionToken) throw new TypeError('Illegal constructor');
    }

    #status(desc: Deno.PermissionDescriptor): Deno.PermissionStatus {
        const key = descriptorKey(desc);
        let status = this.#statuses.get(key);
        if (!status) {
            status = new PermissionStatus(permissionToken);
            this.#statuses.set(key, status);
        }
        return status;
    }

    querySync(desc: Deno.PermissionDescriptor): Deno.PermissionStatus {
        return this.#status(desc);
    }

    async query(desc: Deno.PermissionDescriptor): Promise<Deno.PermissionStatus> {
        return Promise.resolve(this.#status(desc));
    }

    async revoke(desc: Deno.PermissionDescriptor): Promise<Deno.PermissionStatus> {
        return Promise.resolve(this.#status(desc));
    }

    revokeSync(desc: Deno.PermissionDescriptor): Deno.PermissionStatus {
        return this.#status(desc);
    }

    requestSync(desc: Deno.PermissionDescriptor): Deno.PermissionStatus {
        return this.#status(desc);
    }

    async request(desc: Deno.PermissionDescriptor): Promise<Deno.PermissionStatus> {
        return Promise.resolve(this.#status(desc));
    }

    get [Symbol.toStringTag]() {
        return 'Permissions';
    }
}

Object.assign(Deno, {
    permissions: new Permissions(permissionToken),
    Permissions,
    PermissionStatus,
});
