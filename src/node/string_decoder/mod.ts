/**
 * Node.js string_decoder module
 * Decodes buffer data into strings preserving multi-byte characters
 */

const { Decoder } = import.meta.use('text');

export class StringDecoder {
    private _encoding: string;
    private _buffer: Uint8Array;

    constructor(encoding: string = 'utf8') {
        this._encoding = encoding;
        this._buffer = new Uint8Array(0);
    }

    write(buf: Buffer | Uint8Array): string {
        const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        const combined = new Uint8Array(this._buffer.length + data.length);
        combined.set(this._buffer);
        combined.set(data, this._buffer.length);

        const decoder = new Decoder(this._encoding, { stream: true });
        const result = decoder.decode(combined);
        this._buffer = new Uint8Array(0);
        return result;
    }

    end(buf?: Buffer | Uint8Array): string {
        if (buf) {
            const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            const combined = new Uint8Array(this._buffer.length + data.length);
            combined.set(this._buffer);
            combined.set(data, this._buffer.length);
            const decoder = new Decoder(this._encoding);
            const result = decoder.decode(combined);
            this._buffer = new Uint8Array(0);
            return result;
        }
        const decoder = new Decoder(this._encoding);
        const result = decoder.decode(this._buffer);
        this._buffer = new Uint8Array(0);
        return result;
    }
}
