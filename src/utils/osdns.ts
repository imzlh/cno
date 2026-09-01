const os = import.meta.use('os');
const engine = import.meta.use('engine');
const windows = import.meta.use('win32');
const fs = import.meta.use('fs');
const dns = import.meta.use('dns');

let systemDnsServersCache: string[] | undefined;

function parseIPv4DnsServers(value: unknown): string[] {
    const servers = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/[\s,;]+/)
            : [];
    return servers.filter(
        (server): server is string => typeof server === 'string' && server.length > 0 && !server.includes(':'),
    );
}

function readWindowsDnsServers(): string[] {
    if (!windows) return [];
    // Static config (NameServer) takes priority over DHCP-assigned (DhcpNameServer);
    // fall through only if the higher-priority key is empty or unreadable.
    for (const name of ['NameServer', 'DhcpNameServer']) {
        try {
            const servers = parseIPv4DnsServers(windows.readRegistry(
                windows.HKLM,
                'SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters',
                name,
            ));
            if (servers.length > 0) return servers;
        } catch {
            // Keep falling back through the available registry values.
        }
    }
    return [];
}

function readUnixDnsServers(): string[] {
    let source: string;
    try {
        source = engine.decodeString(fs.readFile('/etc/resolv.conf'));
    } catch {
        // File missing, unreadable, or sandboxed away — no system resolver info available.
        return [];
    }

    const servers: string[] = [];
    for (const line of source.split(/\r?\n/)) {
        const match = /^\s*nameserver\s+(\S+)/.exec(line);
        if (!match) continue;
        const candidate = match[1];
        if (candidate && !candidate.includes(':')) servers.push(candidate);
    }
    return servers;
}

export function systemDnsServers(): string[] {
    if (systemDnsServersCache !== undefined) return systemDnsServersCache;

    systemDnsServersCache = os.platform === 'windows' || os.platform === 'win32'
        ? readWindowsDnsServers()
        : readUnixDnsServers();

    return systemDnsServersCache;
}

// inject default DNS to node polyfill
Reflect.set(dns, '__default_dnssrv', systemDnsServers());