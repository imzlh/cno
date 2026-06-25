/**
 * Node.js string_decoder module
 * Decodes buffer data into strings preserving multi-byte characters
 */

const { Decoder } = import.meta.use('text');

export class StringDecoder {
    private _encoding: string;
    private _decoder: InstanceType<typeof Decoder>;

    constructor(encoding: string = 'utf8') {
        this._encoding = encoding;
        this._decoder = new Decoder(encoding, { stream: true });
    }

    write(buf: Buffer | Uint8Array): string {
        const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        return this._decoder.decode(data);
    }

    end(buf?: Buffer | Uint8Array): string {
        const finalDecoder = new Decoder(this._encoding);
        if (buf) {
            const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            return finalDecoder.decode(data);
        }
        return finalDecoder.decode(new Uint8Array(0));
    }
}
