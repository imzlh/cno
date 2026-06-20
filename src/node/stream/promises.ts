import { Stream } from './mod';

export async function pipeline(...streams: (Stream | ((stream: Stream) => Stream) | { signal: AbortSignal })[]): Promise<void> {
    const actualStreams = streams.filter(s => s instanceof Stream) as Stream[];
    for (let i = 0; i < actualStreams.length - 1; i++) {
        // @ts-ignore - Stream pipe compatibility
        actualStreams[i].pipe(actualStreams[i + 1]);
    }
    return new Promise((resolve, reject) => {
        const last = actualStreams[actualStreams.length - 1];
        last.on('finish', resolve);
        last.on('error', reject);
    });
}

export async function finished(stream: Stream, options?: { error?: boolean; readable?: boolean; writable?: boolean; signal?: AbortSignal }): Promise<void> {
    return new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}
