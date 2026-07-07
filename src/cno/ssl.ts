/**
 * CNO ssl lib — SSL/TLS utilities
 */

const ssl = import.meta.use('ssl');

const cnoSsl = {
    createSelfSignedCert(options?: { commonName?: string; days?: number }): CNO.SelfSignedCertResult {
        return ssl.createSelfSignedCert(options);
    },

    loadPEM(data: string, type?: "certificate" | "key"): { subject?: string; type?: string; bits?: number } | null {
        return ssl.loadPEM(data, type);
    },

    get version(): string {
        return ssl.version;
    },
};

Reflect.set(CNO, 'ssl', cnoSsl);
