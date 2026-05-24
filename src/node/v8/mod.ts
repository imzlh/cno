/**
 * Node.js v8 module
 * Based on CModuleEngine (QuickJS) runtime introspection
 */

const engine = import.meta.use('engine');
const os = import.meta.use('os');

export function getHeapStatistics(): Record<string, number> {
    const mem = os.memoryUsage();
    return {
        total_heap_size: mem.used,
        total_heap_size_executable: 0,
        total_physical_size: mem['vm.used'] ?? 0,
        total_available_size: mem['os.free'] ?? 0,
        used_heap_size: mem['vm.used'] ?? 0,
        heap_size_limit: 0,
        malloced_memory: 0,
        peak_malloced_memory: 0,
        does_zap_garbage: 0,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
        total_external_memory: mem["os.total"] ?? 0,
    };
}

export function getHeapSpaceStatistics(): Array<{
    space_name: string; space_size: number; space_used_size: number;
    space_available_size: number; physical_space_size: number;
}> {
    const mem = os.memoryUsage();
    const used = mem['vm.used'] ?? 0;
    return [{
        space_name: 'new_space',
        space_size: used,
        space_used_size: used,
        space_available_size: 0,
        physical_space_size: used,
    }];
}

export function getHeapCodeStatistics(): {
    code_and_metadata_size: number; bytecode_and_metadata_size: number; external_script_source_size: number;
} {
    return { code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0 };
}

export function setFlagsFromString(_flags: string): void {}

export function enableTimeTravel(): void {}
export function disableTimeTravel(): void {}

export function deserialize(buf: Buffer | Uint8Array): any {
    try {
        return engine.deserialize(new Uint8Array(buf));
    } catch {
        return null;
    }
}

export function serialize(value: any): Buffer {
    try {
        const bytes = engine.serialize(value);
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch {
        return Buffer.alloc(0);
    }
}

export class Serializer {
    private _chunks: Uint8Array[] = [];

    writeHeader(): void {}
    writeValue(val: any): boolean {
        try {
            this._chunks.push(engine.serialize(val));
            return true;
        } catch {
            return false;
        }
    }
    releaseBuffer(): Buffer {
        const total = this._chunks.reduce((s, c) => s + c.length, 0);
        const buf = new Uint8Array(total);
        let off = 0;
        for (const c of this._chunks) { buf.set(c, off); off += c.length; }
        this._chunks = [];
        return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    transferArrayBuffer(_id: number, _arrayBuffer: ArrayBuffer): void {}
    writeUint8Array(_input: Uint8Array): void {}
    writeDouble(_value: number): void {}
    writeRawBytes(_source: Uint8Array): void {}
}

export class Deserializer {
    private _buffer: Uint8Array<ArrayBuffer>;
    private _offset = 0;

    constructor(buffer: Buffer<ArrayBuffer> | Uint8Array<ArrayBuffer>) {
        this._buffer = new Uint8Array(buffer);
    }
    readHeader(): boolean { return true; }
    readValue(): any {
        try {
            return engine.deserialize(this._buffer);
        } catch {
            return undefined;
        }
    }
    transferArrayBuffer(_id: number, _arrayBuffer: ArrayBuffer): void {}
    readUint8Array(): Uint8Array { return new Uint8Array(0); }
    readDouble(): number { return 0; }
    readRawBytes(_length: number): Uint8Array { return new Uint8Array(0); }
}

export function cachedDataVersionTag(): number {
    return 0;
}

export const startupSnapshot = {
    isBuildingSnapshot(): boolean { return false; },
    addSerializeCallback(_cb: Function, _data?: any): void {},
    setDeserializeMainFunction(_cb: Function): void {},
};

export const promiseHooks = {
    onInit(_init: Function): void {},
    onBefore(_before: Function): void {},
    onAfter(_after: Function): void {},
    onResolve(_resolve: Function): void {},
};
