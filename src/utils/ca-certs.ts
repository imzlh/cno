/**
 * Platform trust store loader, shared by consumers that cannot rely on
 * OpenSSL's compiled-in default verify paths.
 */

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const engine = import.meta.use('engine');

/** null = not probed yet; [] = probed, nothing found. */
let cached: string[] | null = null;

const POSIX_BUNDLES: Record<string, string[]> = {
    Darwin: ['/etc/ssl/cert.pem', '/opt/homebrew/etc/openssl@3/cert.pem', '/usr/local/etc/openssl@3/cert.pem'],
    FreeBSD: ['/usr/local/share/certs/ca-root-nss.crt', '/etc/ssl/cert.pem'],
};

const LINUX_BUNDLES = [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/pki/tls/cert.pem',
    '/etc/ssl/cert.pem',
];

/**
 * Read the OS trust store once, synchronously.
 *
 * picotls' `ptls_openssl_init_verify_certificate(self, NULL)` builds its store
 * from OpenSSL's compile-time default paths. On Windows those point at
 * `C:\Program Files\Common Files\SSL\{certs,cert.pem}`, which does not exist,
 * so the store stays empty and every verification fails with UNKNOWN_CA.
 * Callers must therefore pass these PEMs explicitly as `caCerts`.
 */
export function systemCaCerts(): string[] {
    if (cached !== null) return cached;
    const collected: string[] = [];

    let sysname = '';
    try {
        sysname = os.uname().sysname;
    } catch {
        // uname unavailable — fall through to the POSIX bundle probe.
    }

    if (sysname === 'Windows_NT') {
        // ROOT = trusted roots, CA = intermediates. Both belong in the store.
        for (const store of ['ROOT', 'CA']) {
            try {
                const win32 = import.meta.use('win32');
                if (win32 === null) break;	// module absent: no point trying the second store
                const certs = win32.exportCerts(store);
                if (certs?.length) collected.push(...certs);
            } catch {
                // Store unreadable or win32 module absent.
            }
        }
    } else {
        for (const path of POSIX_BUNDLES[sysname] ?? LINUX_BUNDLES) {
            try {
                const text = engine.decodeString(new Uint8Array(fs.readFile(path)));
                if (text.includes('BEGIN CERTIFICATE')) {
                    collected.push(text);
                    break;
                }
            } catch {
                // Missing path — try the next candidate.
            }
        }
    }

    cached = collected;
    return collected;
}

/** Merge caller-supplied roots with the platform store. */
export function withSystemCaCerts(caCerts?: string[]): string[] | undefined {
    const system = systemCaCerts();
    if (!caCerts?.length) return system.length ? system : undefined;
    return system.length ? [...caCerts, ...system] : caCerts;
}

/** Concatenated-PEM form of the merged store, cached across calls. */
let cachedBundle: string | null = null;

/**
 * The same roots as `withSystemCaCerts`, concatenated for `ssl.Context.ca`,
 * which takes one PEM string rather than an array.
 *
 * Returns undefined when nothing was found, which is not the same as an empty
 * string: passing `ca: ''` would make `ssl_ctx_load_ca_pem` load zero certs and
 * throw, whereas omitting `ca` leaves OpenSSL's default verify paths as the only
 * source. Callers that need verification must treat undefined as "no roots
 * available" rather than as "trust nothing".
 */
export function systemCaBundle(caCerts?: string[]): string | undefined {
    if (!caCerts?.length) {
        if (cachedBundle === null) cachedBundle = systemCaCerts().join('\n');
        return cachedBundle.length ? cachedBundle : undefined;
    }
    const merged = withSystemCaCerts(caCerts);
    return merged?.length ? merged.join('\n') : undefined;
}
