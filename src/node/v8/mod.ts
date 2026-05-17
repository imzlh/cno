/**
 * Node.js v8 module (stub)
 * V8 engine utilities
 */

export function getHeapStatistics(): Record<string, number> {
    return {
        total_heap_size: 0,
        total_heap_size_executable: 0,
        total_physical_size: 0,
        total_available_size: 0,
        used_heap_size: 0,
        heap_size_limit: 0,
        malloced_memory: 0,
        peak_malloced_memory: 0,
        does_zap_garbage: 0,
        number_of_native_contexts: 0,
        number_of_detached_contexts: 0,
        total_external_memory: 0,
    };
}

export function getHeapSpaceStatistics(): Array<{ space_name: string; space_size: number; space_used_size: number; space_available_size: number; physical_space_size: number }> {
    return [];
}

export function getHeapCodeStatistics(): { code_and_metadata_size: number; bytecode_and_metadata_size: number; external_script_source_size: number } {
    return { code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0 };
}

export function setFlagsFromString(_flags: string): void {}

export function enableTimeTravel(): void {}
export function disableTimeTravel(): void {}

export function deserialize(_buf: Buffer | Uint8Array): any { return null; }
export function serialize(value: any): Buffer { return Buffer.alloc(0); }

export class Serializer {
    writeHeader(): void {}
    writeValue(_val: any): boolean { return false; }
    releaseBuffer(): Buffer { return Buffer.alloc(0); }
    transferArrayBuffer(_id: number, _arrayBuffer: ArrayBuffer): void {}
    writeUint8Array(_input: Uint8Array): void {}
    writeDouble(_value: number): void {}
    writeRawBytes(_source: Uint8Array): void {}
}

export class Deserializer {
    constructor(_buffer: Buffer | Uint8Array) {}
    readHeader(): boolean { return true; }
    readValue(): any { return undefined; }
    transferArrayBuffer(_id: number, _arrayBuffer: ArrayBuffer): void {}
    readUint8Array(): Uint8Array { return new Uint8Array(0); }
    readDouble(): number { return 0; }
    readRawBytes(_length: number): Uint8Array { return new Uint8Array(0); }
}

export function cachedDataVersionTag(): number { return 0; }

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
