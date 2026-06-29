export * from './mod';
export * as promises from './promises';

import { Stream } from './mod';
import * as stream from './mod';
import * as streamPromises from './promises';

type StreamPipelineArgs =
    | [...streams: any[], callback: (error?: Error | null) => void]
    | any[];

export function pipeline(...args: StreamPipelineArgs): any {
    const callback = typeof args[args.length - 1] === 'function'
        ? args.pop() as (error?: Error | null) => void
        : undefined;
    const streams = args as any[];
    const promise = (streamPromises.pipeline as any)(...streams);
    if (callback) {
        promise.then(
            () => callback(null),
            (error: Error) => callback(error),
        );
    }
    return streams[streams.length - 1];
}

export function finished(streamInstance: any, options?: any, callback?: (error?: Error | null) => void): any {
    let cb = callback;
    let opts = options;
    if (typeof options === 'function') {
        cb = options;
        opts = undefined;
    }
    const promise = (streamPromises.finished as any)(streamInstance, opts);
    if (cb) {
        promise.then(
            () => cb!(null),
            (error: Error) => cb!(error),
        );
    }
    return streamInstance;
}

export default Object.assign(Stream, stream, {
    pipeline,
    finished,
    promises: streamPromises,
});
