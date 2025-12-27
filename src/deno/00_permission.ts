class PermissionStatus extends EventTarget implements Deno.PermissionStatus {
    public onchange: ((this: Deno.PermissionStatus, ev: Event) => any) | null = null;
    public state: Deno.PermissionState = 'granted';
    public partial: boolean = false;
}

class Permission implements Deno.Permissions {
    #status = new PermissionStatus();

    querySync(desc: Deno.PermissionDescriptor): Deno.PermissionStatus {
        return this.#status;
    }

    async query(desc: Deno.PermissionDescriptor): Promise<Deno.PermissionStatus> {
        return Promise.resolve(this.#status);
    }

    revoke(desc: Deno.PermissionDescriptor): Promise<Deno.PermissionStatus> {
        return Promise.resolve(this.#status);
    }

    revokeSync(desc: Deno.PermissionDescriptor): Deno.PermissionStatus {
        return this.#status;
    }

    requestSync(desc: Deno.PermissionDescriptor): Deno.PermissionStatus {
        return this.#status;
    }

    request(desc: Deno.PermissionDescriptor): Promise<Deno.PermissionStatus> {
        return Promise.resolve(this.#status);
    }
}

Object.assign(Deno, {
    permissions: new Permission(),
    PermissionStatus,
} as Partial<typeof Deno>);