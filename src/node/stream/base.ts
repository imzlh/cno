/**
 * node:stream Stream — the base class every other stream class inherits from.
 *
 * Owns Stream.prototype.pipe (the generic pipe used by all subclasses) and the
 * bare-Stream destroy()/closed pair that reads the `baseStreamStates` side
 * table in ./_shared.
 */

import { EventEmitter } from '../events';
import {
    baseStreamState,
    baseStreamStates,
    flattenPrototype,
    initStream,
    isConstructCallTarget,
    runStreamDestroy,
} from './_shared';
import type {
    MaybePausable,
    PipeOptions,
    PipeTrackedWritable,
    Stream as StreamShape,
    StreamConstructor,
    Writable,
} from './types';

export interface Stream extends StreamShape {}

export const Stream: StreamConstructor = function Stream(this: Stream | undefined) {
    const target = isConstructCallTarget(this, Stream.prototype)
        ? this
        : Object.create(Stream.prototype);
    initStream(target);
    return target;
} as StreamConstructor;

Object.setPrototypeOf(Stream, EventEmitter);
Stream.prototype = Object.create(EventEmitter.prototype);

Stream.prototype.pipe = function pipe<T extends Writable>(this: Stream, destination: T, options?: PipeOptions): T {
    const src = this as Stream & MaybePausable;
    const trackedDestination = destination as PipeTrackedWritable;
    let drained = true;

    if (!Array.isArray(this._pipedDestinations)) this._pipedDestinations = [];
    this._pipedDestinations.push(destination);

    const onData = (chunk: unknown) => {
        if (!destination.write(chunk)) {
            drained = false;
            src.pause?.();
        }
    };

    const onDrain = () => {
        if (!drained) {
            drained = true;
            src.resume?.();
        }
    };

    const onEnd = () => {
        if (options?.end !== false) {
            destination.end();
        }
        cleanup(true);
    };

    const cleanup = (emitUnpipe = false) => {
        const cleanups = trackedDestination.__pipeCleanups;
        const entryIndex = cleanups?.findIndex(entry => entry.source === this && entry.cleanup === cleanup) ?? -1;
        const wasPiped = entryIndex !== -1;
        this.removeListener('data', onData);
        destination.removeListener('drain', onDrain);
        this.removeListener('end', onEnd);
        this.removeListener('close', onClose);
        destination.removeListener('close', onDestClose);
        if (wasPiped && cleanups) {
            cleanups.splice(entryIndex, 1);
            if (cleanups.length === 0) delete trackedDestination.__pipeCleanups;
        }
        const idx = this._pipedDestinations.indexOf(destination);
        if (idx !== -1) this._pipedDestinations.splice(idx, 1);
        if (emitUnpipe && wasPiped) destination.emit('unpipe', this);
    };

    const onClose = () => {
        cleanup(true);
    };

    const onDestClose = () => {
        cleanup(true);
        if (!src.destroyed) src.pause?.();
    };

    this.on('data', onData);
    destination.on('drain', onDrain);
    this.on('end', onEnd);
    this.on('close', onClose);
    destination.on('close', onDestClose);

    const cleanups = trackedDestination.__pipeCleanups ??= [];
    cleanups.push({ source: this, cleanup });
    destination.emit('pipe', this);
    src.resume?.();

    // Source already at EOF: 'end' fired before this pipe existed, so `onEnd`
    // above would never run and the destination would wait forever for an end
    // that never comes. Node ends the destination in this shape (measured on
    // v24.18.0), which is what lets pipeline() over a consumed source resolve.
    // Deferred so 'pipe' is observed first and ordering matches the live path.
    const alreadyEnded = (this as Stream & {
        readableEnded?: boolean;
        _readableState?: { endEmitted?: boolean };
    }).readableEnded === true
        || (this as Stream & {
            _readableState?: { endEmitted?: boolean };
        })._readableState?.endEmitted === true;
    if (alreadyEnded) {
        process.nextTick(() => {
            if (this._pipedDestinations.indexOf(destination) === -1) return;
            onEnd();
        });
    }

    return destination;
};

Stream.prototype.destroy = function destroy(this: Stream, error?: Error | null): Stream {
    if (this.destroyed) return this;
    this.destroyed = true;
    const state = baseStreamState(this);
    state.destroyed = true;
    runStreamDestroy(this, error, [state]);
    return this;
};

/* `closed` reads through to whichever state object the concrete stream owns; a
 * bare Stream falls back to its side table entry. Readable/Writable/Duplex
 * override this getter with a state-specific one. */
Object.defineProperty(Stream.prototype, 'closed', {
    get(this: Stream): boolean {
        return baseStreamStates.get(this)?.closed ?? false;
    },
    enumerable: false,
    configurable: true,
});

Object.defineProperty(Stream.prototype, 'constructor', {
    value: Stream,
    writable: true,
    configurable: true,
});

flattenPrototype(Stream.prototype);
