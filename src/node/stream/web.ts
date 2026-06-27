function getGlobal(name: keyof typeof globalThis): any {
    return (globalThis as any)[name];
}

export const ReadableStream = getGlobal('ReadableStream');
export const ReadableStreamDefaultReader = getGlobal('ReadableStreamDefaultReader');
export const ReadableStreamBYOBReader = getGlobal('ReadableStreamBYOBReader');
export const ReadableStreamBYOBRequest = getGlobal('ReadableStreamBYOBRequest');
export const ReadableByteStreamController = getGlobal('ReadableByteStreamController');
export const ReadableStreamDefaultController = getGlobal('ReadableStreamDefaultController');
export const TransformStream = getGlobal('TransformStream');
export const TransformStreamDefaultController = getGlobal('TransformStreamDefaultController');
export const WritableStream = getGlobal('WritableStream');
export const WritableStreamDefaultWriter = getGlobal('WritableStreamDefaultWriter');
export const WritableStreamDefaultController = getGlobal('WritableStreamDefaultController');
export const ByteLengthQueuingStrategy = getGlobal('ByteLengthQueuingStrategy');
export const CountQueuingStrategy = getGlobal('CountQueuingStrategy');
export const TextEncoderStream = getGlobal('TextEncoderStream');
export const TextDecoderStream = getGlobal('TextDecoderStream');
export const CompressionStream = getGlobal('CompressionStream');
export const DecompressionStream = getGlobal('DecompressionStream');

export default {
    ReadableStream,
    ReadableStreamDefaultReader,
    ReadableStreamBYOBReader,
    ReadableStreamBYOBRequest,
    ReadableByteStreamController,
    ReadableStreamDefaultController,
    TransformStream,
    TransformStreamDefaultController,
    WritableStream,
    WritableStreamDefaultWriter,
    WritableStreamDefaultController,
    ByteLengthQueuingStrategy,
    CountQueuingStrategy,
    TextEncoderStream,
    TextDecoderStream,
    CompressionStream,
    DecompressionStream,
};
