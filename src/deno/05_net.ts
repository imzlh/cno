const os = import.meta.use('os');
Object.assign(Deno, {
    networkInterfaces(){
        const intf = os.networkInterfaces();
        return intf.map(i => ({
            ...i,
            family: i.address.includes(':')? 'IPv6' : 'IPv4',
            scopeid: i.scopeId,
            cidr: i.netmask
        }));
    }
} as Partial<typeof Deno>);