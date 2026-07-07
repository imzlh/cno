import { Headers } from "../headers";
import { resolveObjectURL } from "../url";
import { toOwnedBytes } from "../../utils/bytes";
import { engine } from "./helpers";

type Uint8Array = globalThis.Uint8Array<ArrayBuffer>;

const algorithm = import.meta.use("algorithm");

export interface LocalProtocolResponse {
    url: string;
    status: number;
    headers: Headers;
    body: Uint8Array;
}

function isHex(code: number): boolean {
    return (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 70) ||
        (code >= 97 && code <= 102);
}

function hexValue(code: number): number {
    if (code <= 57) return code - 48;
    if (code <= 70) return code - 55;
    return code - 87;
}

function percentDecodeBytes(value: string): Uint8Array {
    const chunks: Uint8Array[] = [];
    let ascii: number[] = [];
    const flushAscii = () => {
        if (ascii.length === 0) return;
        const chunk = new Uint8Array(ascii.length);
        chunk.set(ascii);
        chunks.push(chunk);
        ascii = [];
    };

    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code === 37 && i + 2 < value.length) {
            const hi = value.charCodeAt(i + 1);
            const lo = value.charCodeAt(i + 2);
            if (isHex(hi) && isHex(lo)) {
                ascii.push((hexValue(hi) << 4) | hexValue(lo));
                i += 2;
                continue;
            }
        }
        if (code <= 0x7f) {
            ascii.push(code);
            continue;
        }
        flushAscii();
        chunks.push(engine.encodeString(value.charAt(i)));
    }
    flushAscii();
    return chunks.length === 1 && chunks[0] ? chunks[0] : toOwnedBytes(algorithm.bytesConcat(chunks));
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

export function isLocalFetchProtocol(protocol: string): boolean {
    return protocol === 'data:' || protocol === 'blob:';
}

export async function loadLocalProtocol(url: URL, rawUrl = url.href): Promise<LocalProtocolResponse | null> {
    if (url.protocol === 'data:') return dataUrlBytes(url, rawUrl);
    if (url.protocol === 'blob:') return blobUrlBytes(url);
    return null;
}
