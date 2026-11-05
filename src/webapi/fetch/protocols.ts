import { Headers } from "../headers";
import { resolveObjectURL } from "../url";
import { sanitizeSurrogates, toOwnedBytes } from "../../utils/bytes";
import { toFsPath } from "../../utils/path";
import { asyncfs, engine } from "./helpers";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

const algorithm = import.meta.use("algorithm");

export interface LocalProtocolResponse {
    url: string;
    status: number;
    headers: Headers;
    body: Uint8Array;
}

function percentDecodeBytes(value: string): Uint8Array {
    // Encode the whole string once, then expand %XX in a single pass over the
    // bytes — no per-char encodeString and no growable scratch array. Valid
    // non-BMP characters survive intact; only lone surrogates become FFFD,
    // matching percentDecodeUtf8 in webapi/url.ts.
    const source = engine.encodeString(sanitizeSurrogates(value));
    const out = new Uint8Array(source.length);
    let length = 0;
    for (let i = 0; i < source.length;) {
        if (source[i] === 37 && i + 2 < source.length) {
            const hi = hexValue(source[i + 1]);
            const lo = hexValue(source[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out[length++] = (hi << 4) | lo;
                i += 3;
                continue;
            }
        }
        out[length++] = source[i];
        i++;
    }
    return length === out.length ? out : toOwnedBytes(out.subarray(0, length));
}

function hexValue(byte: number): number {
    if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
    if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
    if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
    return -1;
}

function dataUrlBytes(url: URL, rawUrl: string): LocalProtocolResponse {
    const rawWithFragment = rawUrl;
    const hash = rawWithFragment.indexOf('#');
    const raw = hash === -1 ? rawWithFragment : rawWithFragment.slice(0, hash);
    const comma = raw.indexOf(',');
    if (comma === -1) throw new TypeError(`Invalid data URL: ${url.href}`);

    const meta = raw.slice('data:'.length, comma);
    const bodyText = raw.slice(comma + 1);
    const parts = meta.split(';');
    const base64 = parts.some((part) => part.toLowerCase() === 'base64');
    const mediaParts = parts.filter((part) => part.toLowerCase() !== 'base64');
    const contentType = mediaParts.join(';') || 'text/plain;charset=US-ASCII';
    const body = base64
        ? toOwnedBytes(algorithm.base64DecodeLoose(bodyText.replace(/[\t\n\f\r ]+/g, '')))
        : percentDecodeBytes(bodyText);

    return {
        url: rawUrl,
        status: 200,
        headers: new Headers({ 'content-type': contentType }),
        body,
    };
}

async function blobUrlBytes(url: URL): Promise<LocalProtocolResponse> {
    const blob = resolveObjectURL(url);
    if (!blob) throw new TypeError(`Invalid object URL: ${url.href}`);
    const body = toOwnedBytes(new Uint8Array(await blob.arrayBuffer()));
    return {
        url: url.href,
        status: 200,
        headers: new Headers(blob.type ? { 'content-type': blob.type } : undefined),
        body,
    };
}

async function fileUrlBytes(url: URL): Promise<LocalProtocolResponse> {
    const body = toOwnedBytes(new Uint8Array(await asyncfs.readFile(toFsPath(url))));
    return {
        url: url.href,
        status: 200,
        headers: new Headers(),
        body,
    };
}

export function isLocalFetchProtocol(protocol: string): boolean {
    return protocol === 'data:' || protocol === 'blob:' || protocol === 'file:';
}

export async function loadLocalProtocol(url: URL, rawUrl = url.href): Promise<LocalProtocolResponse | null> {
    if (url.protocol === 'data:') return dataUrlBytes(url, rawUrl);
    if (url.protocol === 'blob:') return blobUrlBytes(url);
    if (url.protocol === 'file:') return fileUrlBytes(url);
    return null;
}
