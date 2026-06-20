/**
 * Node.js string_decoder module
 * Decodes buffer data into strings preserving multi-byte characters
 */

const { Decoder } = import.meta.use('text');

export class StringDecoder {
    private _encoding: string;
    private _lastBytes: Uint8Array;
    private _decoder: InstanceType<typeof Decoder>;

    constructor(encoding: string = 'utf8') {
        this._encoding = encoding;
        this._lastBytes = new Uint8Array(0);
        this._decoder = new Decoder(encoding, { stream: true });
    }

    write(buf: Buffer | Uint8Array): string {
        const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        if (this._lastBytes.length > 0) {
            const combined = new Uint8Array(this._lastBytes.length + data.length);
            combined.set(this._lastBytes);
            combined.set(data, this._lastBytes.length);
            this._lastBytes = new Uint8Array(0);
            return this._decoder.decode(combined);
        }
        return this._decoder.decode(data);
    }

    end(buf?: Buffer | Uint8Array): string {
        const finalDecoder = new Decoder(this._encoding);
        if (buf) {
            const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            if (this._lastBytes.length > 0) {
                const combined = new Uint8Array(this._lastBytes.length + data.length);
                combined.set(this._lastBytes);
                combined.set(data, this._lastBytes.length);
                this._lastBytes = new Uint8Array(0);
                return finalDecoder.decode(combined);
            }
            this._lastBytes = new Uint8Array(0);
            return finalDecoder.decode(data);
        }
        const result = finalDecoder.decode(this._lastBytes);
        this._lastBytes = new Uint8Array(0);
        return result;
    }
}
