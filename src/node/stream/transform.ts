/**
 * node:stream Transform and PassThrough.
 *
 * PassThrough lives beside Transform because its prototype chain is
 * Object.create(Transform.prototype) and its flattenPrototype() has to run
 * after Transform's.
 */

import { Duplex } from './duplex';
import { asError, flattenPrototype, isConstructCallTarget } from './_shared';
import type {
    PassThrough as PassThroughShape,
    PassThroughConstructor,
    Transform as TransformShape,
    TransformConstructor,
    TransformOptions,
} from './types';

export interface Transform extends TransformShape {}

export interface PassThrough extends PassThroughShape {}

function initTransform(self: Transform, options?: TransformOptions): void {
    Duplex.call(self, options);
    if (options?.transform) {
        self._transform = options.transform;
    }
    if (options?.flush) {
        self._flush = options.flush;
    }
}

export const Transform: TransformConstructor = function Transform(this: Transform | undefined, options?: TransformOptions) {
    const target = isConstructCallTarget(this, Transform.prototype)
        ? this
        : Object.create(Transform.prototype);
    initTransform(target, options);
    return target;
} as TransformConstructor;

Object.setPrototypeOf(Transform, Duplex);
Transform.prototype = Object.create(Duplex.prototype);

Transform.prototype._transform = function _transform(
    this: Transform,
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: unknown) => void
): void {
    throw new Error('_transform() must be implemented');
};

/* Node parks the write callback of a transform whose push() filled the readable
 * side, and only releases it from _read() once a consumer has drained. Without
 * that, write() reports `true` forever and the readable buffer grows without
 * bound (measured at 25x highWaterMark). Held off the instance so it cannot
 * collide with a subclass field, and off _writableState so flattenPrototype and
 * the shared state shape stay untouched. */
const transformPendingWriteCallbacks = new WeakMap<object, (error?: Error | null) => void>();

/* Release a parked callback. Node's Transform.prototype._read does exactly this
 * and nothing else: the readable output of a transform is produced by writes,
 * not by pulls, so the only work a read can do is let the next write proceed. */
function releaseTransformWrite(self: Transform): void {
    const pending = transformPendingWriteCallbacks.get(self);
    if (!pending) return;
    transformPendingWriteCallbacks.delete(self);
    pending();
}

Transform.prototype._read = function _read(this: Transform, _size: number): void {
    // A pull is the signal that the readable side made room, so it is what
    // unparks the write callback withheld by _write below. When nothing is
    // parked this stays the no-op it always was: a transform's readable output
    // is driven by writes, so there is nothing else a read could produce.
    releaseTransformWrite(this);
};

Transform.prototype._write = function _write(
    this: Transform,
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
): void {
    const readableState = this._readableState;
    const writableState = this._writableState;
    // Sampled before _transform runs so a transform that pushes nothing (a
    // digest accumulating state, a filter dropping a chunk) is never made to
    // wait for a read that has nothing to consume.
    const lengthBefore = this.readableLength;

    let called = false;
    const onTransform = (err?: Error | null, data?: unknown) => {
        if (called) return;
        called = true;
        if (err) return callback(err);
        // Node's afterTransform tests `val != null`: cb(null, null) pushes
        // nothing. Forwarding null to push() would signal EOF and end the
        // readable side after the very first chunk.
        if (data !== undefined && data !== null) this.push(data);

        if (
            // end() was already called: parking now would strand the writable
            // buffer and 'finish' would never fire.
            writableState.ended
            // Nothing was pushed, so no read can release us.
            || lengthBefore === this.readableLength
            // The readable side still has room.
            || this.readableLength < readableState.highWaterMark
        ) {
            callback();
            return;
        }
        transformPendingWriteCallbacks.set(this, callback);
    };
    try {
        this._transform(chunk, encoding, onTransform);
    } catch (err) {
        onTransform(asError(err));
    }
};

Transform.prototype._final = function _final(this: Transform, callback: (error?: Error | null) => void): void {
    let called = false;
    const done = (err?: Error | null, data?: unknown) => {
        if (called) return;
        called = true;
        if (err) return callback(err);
        if (data !== undefined) this.push(data);
        this.push(null);
        callback();
    };

    if (this._flush) {
        try {
            this._flush(done);
        } catch (err) {
            done(asError(err));
        }
    } else {
        done();
    }
};

Object.defineProperty(Transform.prototype, 'constructor', {
    value: Transform,
    writable: true,
    configurable: true,
});

flattenPrototype(Transform.prototype);

export const PassThrough: PassThroughConstructor = function PassThrough(this: PassThrough | undefined, options?: TransformOptions) {
    const target = isConstructCallTarget(this, PassThrough.prototype)
        ? this
        : Object.create(PassThrough.prototype);
    Transform.call(target, options);
    return target;
} as PassThroughConstructor;

Object.setPrototypeOf(PassThrough, Transform);
PassThrough.prototype = Object.create(Transform.prototype);

PassThrough.prototype._transform = function _transform(
    this: PassThrough,
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: unknown) => void
): void {
    callback(null, chunk);
};

Object.defineProperty(PassThrough.prototype, 'constructor', {
    value: PassThrough,
    writable: true,
    configurable: true,
});

flattenPrototype(PassThrough.prototype);
