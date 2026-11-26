import { Buffer } from '../buffer';
import type { BinaryInput } from './types';
import { createPublicKey, exportKeyObjectBytes, type KeyObject } from './keys';
import { isKeyObject, toBuffer } from './helpers';
import { withCode } from './errors';

const ssl = import.meta.use('ssl');

export type X509CheckOptions = NonNullable<Parameters<CModuleSSL.Certificate['checkHost']>[1]>;
export type X509CertificateInfo = CModuleSSL.CertificateInfo;

type LegacyNameValue = string | string[];
type LegacyName = Record<string, LegacyNameValue>;

export type X509LegacyObject = {
    subject: LegacyName;
    issuer: LegacyName;
    subjectaltname: string | undefined;
    infoAccess: Record<string, string[]> | undefined;
    ca: boolean;
    valid_from: string;
    valid_to: string;
    fingerprint: string;
    fingerprint256: string;
    fingerprint512: string;
    ext_key_usage: string[] | undefined;
    serialNumber: string;
    raw: Buffer;
};

function keyForCertificate(value: unknown, expected: 'public' | 'private'): KeyObject {
    if (!isKeyObject(value)) {
        throw codedTypeError('ERR_INVALID_ARG_TYPE', 'The "pkey" argument must be an instance of KeyObject');
    }
    if (value.type !== expected) {
        throw codedTypeError('ERR_INVALID_ARG_VALUE', `The "pkey" argument must be a ${expected} KeyObject`);
    }
    return value;
}

function parseLegacyName(value: string): LegacyName {
    const result = Object.create(null) as LegacyName;
    for (const match of value.matchAll(/((?:\\.|[^\\\n])+?)(?: \+ |\n|$)/g)) {
        const line = match[1]!;
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        const key = line.slice(0, separator);
        const item = line.slice(separator + 1).replace(/\\([0-9a-fA-F]{2}|.)/g, (_match, escape: string) =>
            escape.length === 2 ? String.fromCharCode(parseInt(escape, 16)) : escape);
        const previous = result[key];
        if (previous === undefined) {
            result[key] = item;
        } else if (Array.isArray(previous)) {
            previous.push(item);
        } else {
            result[key] = [previous, item];
        }
    }
    return result;
}

function parseLegacyInfoAccess(value: string | undefined): Record<string, string[]> | undefined {
    if (value === undefined) return undefined;
    const result = Object.create(null) as Record<string, string[]>;
    for (const line of value.split('\n')) {
        const separator = line.indexOf(':');
        if (separator <= 0) continue;
        const method = line.slice(0, separator);
        let location = line.slice(separator + 1);
        if (location.startsWith('"') && location.endsWith('"')) {
            location = JSON.parse(location) as string;
        }
        const entries = result[method] ??= [];
        entries.push(location);
    }
    return result;
}

function codedTypeError(code: 'ERR_INVALID_ARG_TYPE' | 'ERR_INVALID_ARG_VALUE', message: string): TypeError {
    return withCode(new TypeError(message), code);
}

function validateString(value: unknown, name: string): asserts value is string {
    if (typeof value !== 'string') {
        throw codedTypeError('ERR_INVALID_ARG_TYPE', `The "${name}" argument must be of type string`);
    }
}

function readOptionalBooleanOption(values: Record<string, unknown>, name: string): boolean | undefined {
    const value = values[name];
    if (value !== undefined && typeof value !== 'boolean') {
        throw codedTypeError('ERR_INVALID_ARG_TYPE', `The "options.${name}" property must be of type boolean`);
    }
    return value;
}

function validateCheckOptions(options: unknown, host: boolean): X509CheckOptions | undefined {
    if (options === undefined) return undefined;
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw codedTypeError('ERR_INVALID_ARG_TYPE', 'The "options" argument must be of type object');
    }
    const values = options as Record<string, unknown>;
    const snapshot: X509CheckOptions = {};
    const subject = values.subject;
    if (subject !== undefined && typeof subject !== 'string') {
        throw codedTypeError('ERR_INVALID_ARG_TYPE', 'The "options.subject" property must be of type string');
    }
    if (subject !== undefined && subject !== 'default' && subject !== 'always' && subject !== 'never') {
        throw codedTypeError('ERR_INVALID_ARG_VALUE', "The property 'options.subject' is invalid");
    }
    if (subject !== undefined) snapshot.subject = subject;
    if (!host) return snapshot;

    const wildcards = readOptionalBooleanOption(values, 'wildcards');
    const partialWildcards = readOptionalBooleanOption(values, 'partialWildcards');
    const multiLabelWildcards = readOptionalBooleanOption(values, 'multiLabelWildcards');
    const singleLabelSubdomains = readOptionalBooleanOption(values, 'singleLabelSubdomains');
    if (wildcards !== undefined) snapshot.wildcards = wildcards;
    if (partialWildcards !== undefined) snapshot.partialWildcards = partialWildcards;
    if (multiLabelWildcards !== undefined) snapshot.multiLabelWildcards = multiLabelWildcards;
    if (singleLabelSubdomains !== undefined) snapshot.singleLabelSubdomains = singleLabelSubdomains;
    return snapshot;
}

export class X509Certificate {
    #native: CModuleSSL.Certificate;
    #info: CModuleSSL.CertificateInfo | undefined;
    #publicKey: KeyObject | undefined;

    constructor(data: BinaryInput) {
        this.#native = new ssl.Certificate(toBuffer(data));
    }

    get #certificateInfo(): CModuleSSL.CertificateInfo {
        return this.#info ??= this.#native.info;
    }

    get info(): X509CertificateInfo {
        const info = this.#certificateInfo;
        return {
            ...info,
            ...(info.keyUsage ? { keyUsage: [...info.keyUsage] } : {}),
        };
    }

    get ca(): boolean { return this.#certificateInfo.ca; }
    get subject(): string { return this.#certificateInfo.subject; }
    get issuer(): string { return this.#certificateInfo.issuer; }
    get subjectAltName(): string | undefined { return this.#certificateInfo.subjectAltName; }
    get infoAccess(): string | undefined { return this.#certificateInfo.infoAccess; }
    get validFrom(): string { return this.#certificateInfo.validFrom; }
    get validTo(): string { return this.#certificateInfo.validTo; }
    get validFromDate(): Date { return new Date(this.#certificateInfo.validFromMs); }
    get validToDate(): Date { return new Date(this.#certificateInfo.validToMs); }
    get validFromMs(): number { return this.#certificateInfo.validFromMs; }
    get validToMs(): number { return this.#certificateInfo.validToMs; }
    get serialNumber(): string { return this.#certificateInfo.serialNumber; }
    get keyUsage(): string[] | undefined {
        const keyUsage = this.#certificateInfo.keyUsage;
        return keyUsage ? [...keyUsage] : undefined;
    }
    get signatureAlgorithm(): string | undefined { return this.#certificateInfo.signatureAlgorithm; }
    get signatureAlgorithmOid(): string | undefined { return this.#certificateInfo.signatureAlgorithmOid; }

    get fingerprint(): string { return this.#native.fingerprint; }
    get fingerprint256(): string { return this.#native.fingerprint256; }
    get fingerprint512(): string { return this.#native.fingerprint512; }

    get raw(): Buffer {
        return Buffer.from(this.#native.raw);
    }

    get publicKey(): KeyObject {
        if (!this.#publicKey) {
            this.#publicKey = createPublicKey({
                key: Buffer.from(this.#native.publicKey),
                type: 'spki',
                format: 'der',
            });
        }
        return this.#publicKey;
    }

    get pem(): string { return this.#native.pem; }
    get issuerCertificate(): undefined { return undefined; }

    checkHost(name: string, options?: X509CheckOptions): string | undefined {
        validateString(name, 'name');
        const checkedOptions = validateCheckOptions(options, true);
        return this.#native.checkHost(name, checkedOptions);
    }

    checkEmail(email: string, options?: Pick<X509CheckOptions, 'subject'>): string | undefined {
        validateString(email, 'email');
        const checkedOptions = validateCheckOptions(options, false);
        return this.#native.checkEmail(email, checkedOptions);
    }

    checkIP(ip: string): string | undefined {
        validateString(ip, 'ip');
        return this.#native.checkIP(ip);
    }

    checkIssued(otherCertificate: X509Certificate): boolean {
        if (!(otherCertificate instanceof X509Certificate)) {
            throw codedTypeError('ERR_INVALID_ARG_TYPE', 'The "otherCert" argument must be an instance of X509Certificate');
        }
        return this.#native.checkIssued(otherCertificate.#native);
    }

    verify(publicKey: KeyObject): boolean {
        const key = keyForCertificate(publicKey, 'public');
        return this.#native.verify(exportKeyObjectBytes(key, 'der'));
    }

    checkPrivateKey(privateKey: KeyObject): boolean {
        const key = keyForCertificate(privateKey, 'private');
        return this.#native.checkPrivateKey(exportKeyObjectBytes(key, 'der'));
    }

    toString(): string { return this.pem; }
    toJSON(): string { return this.pem; }

    toLegacyObject(): X509LegacyObject {
        return {
            subject: parseLegacyName(this.subject),
            issuer: parseLegacyName(this.issuer),
            subjectaltname: this.subjectAltName,
            infoAccess: parseLegacyInfoAccess(this.infoAccess),
            ca: this.ca,
            valid_from: this.validFrom,
            valid_to: this.validTo,
            fingerprint: this.fingerprint,
            fingerprint256: this.fingerprint256,
            fingerprint512: this.fingerprint512,
            ext_key_usage: this.keyUsage,
            serialNumber: this.serialNumber,
            raw: this.raw,
        };
    }
}
