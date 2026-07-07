/**
 * CNO engine lib — JS engine capabilities
 */

const engine = import.meta.use('engine');

const cnoEngine = {
    serialize(obj: unknown): Uint8Array {
        return engine.serialize(obj);
    },

    deserialize<T = unknown>(buf: Uint8Array<ArrayBuffer>): T {
        return engine.deserialize(buf);
    },

    async evalModule(code: string, importMeta?: Record<string, unknown>): Promise<unknown> {
        const meta = importMeta ?? { url: '', main: false };
        const url = typeof meta.url === 'string' ? meta.url : '';
        const mod = new engine.Module(code, url || '<eval>');
        return mod.eval();
    },

    compileModule(code: string, importMeta?: Record<string, unknown>): Uint8Array {
        const meta = importMeta ?? { url: '', main: false };
        const url = typeof meta.url === 'string' ? meta.url : '';
        const mod = new engine.Module(code, url || '<compile>');
        return new Uint8Array(mod.dump(engine.DUMP_BYTECODE));
    },

    encodeString(str: string): Uint8Array {
        return engine.encodeString(str);
    },

    decodeString(buf: Uint8Array<ArrayBuffer> | ArrayBuffer): string {
        return engine.decodeString(buf);
    },

    setMemoryLimit(limit: number): void {
        engine.setMemoryLimit(limit);
    },

    setMaxStackSize(size: number): void {
        engine.setMaxStackSize(size);
    },

    get versions(): CNO.engine.EngineVersions {
        return Object.assign({ curl: '', expat: '' }, engine.versions);
    },

    get gc(): CNO.engine.GarbageCollector {
        return engine.gc;
    },
};

Reflect.set(CNO, 'engine', cnoEngine);
