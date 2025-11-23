const fs = import.meta.use("fs");
const asfs = import.meta.use("asyncfs");
const engine = import.meta.use("engine");
const fswatch = import.meta.use("fswatch");

import { errors } from "./01_errors";

const toString = (e: URL | string) => e instanceof URL ? e.pathname : e;

async function denoWriteAnyFile(path: string | URL, data: string | Uint8Array | ReadableStream<string | Uint8Array>, options?: Deno.WriteFileOptions) {
    let flag = "w";
    if (options?.append) {
        flag = "a";
    } else if (options?.create) {
        flag = "x";
    } else if (options?.createNew) {
        flag = "wx";
    }
    const fhandle = await asfs.open(toString(path), flag, options?.mode);

    if (typeof data === "string")
        data = engine.encodeString(data);

    if (data instanceof Uint8Array) {
        let written = 0;
        while (written < data.length) {
            const n = await fhandle.write(data.subarray(written));
            if (n === null) {
                throw new errors.UnexpectedEof("write");
            }
            written += n;
        }
    } else {
        const reader = data.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const n = await fhandle.write(
                typeof value === "string" ? engine.encodeString(value) : value
            );
            if (n === null) {
                throw new errors.UnexpectedEof("write");
            }
        }
    }
    await fhandle.close();
}

Object.assign(Deno, {
    // @ts-ignore not SharedArrayBuffer
    readFile(path, opt) {
        return asfs.readFile(toString(path));
    },

    readFileSync(path) {
        return new Uint8Array(fs.readFile(toString(path)));
    },

    readTextFile(path, opt) {
        return Deno.readFile(path, opt).then(b => engine.decodeString(b));
    },

    readTextFileSync(path) {
        return engine.decodeString(Deno.readFileSync(path));
    },


    async *readDir(path) {
        const h = await asfs.readDir(toString(path));
        while (true) {
            const e = await h.next();
            if (e.done) break;
            yield {
                name: e.value.name,
                isDirectory: e.value.isDirectory,
                isFile: e.value.isFile,
                isSymlink: e.value.isSymbolicLink,
            } as Deno.DirEntry;
        }
    },

    *readDirSync(path) {
        for (const el of fs.readdir(toString(path))) {
            const stat = fs.stat(path + "/" + el);
            yield {
                name: el,
                isDirectory: stat.isDirectory,
                isFile: stat.isFile,
                isSymlink: stat.isSymbolicLink,
            } as Deno.DirEntry;
        }
    },

    readLink(path) {
        return asfs.readLink(toString(path));
    },

    readLinkSync(path) {
        throw new errors.NotSupported("readLinkSync");
    },

    realPath(path) {
        return asfs.realPath(toString(path));
    },

    realPathSync(path) {
        return fs.realpath(toString(path));
    },

    removeSync(path) {
        fs.unlink(toString(path));
    },

    remove(path) {
        return asfs.unlink(toString(path));
    },

    renameSync(oldPath, newPath) {
        fs.rename(toString(oldPath), toString(newPath));
    },

    rename(oldPath, newPath) {
        return asfs.rename(toString(oldPath), toString(newPath));
    },

    writeFileSync(path, data, options) {
        // todo: options
        fs.writeFile(toString(path), data.buffer as ArrayBuffer);
    },

    writeFile(path, data, options) {
        return denoWriteAnyFile(path, data, options);
    },

    writeTextFileSync(path, data, options) {
        // todo: options
        fs.writeFile(toString(path), engine.encodeString(data).buffer as ArrayBuffer);
    },

    writeTextFile(path, data, options) {
        return denoWriteAnyFile(path, data, options);
    },

    // async *watchFs(paths, options) {
    //     const pathArray = typeof paths === "string" ? [paths] : paths;
    //     const watchers = await Promise.all(
    //         pathArray.map(path => fswatch.watch(toString(path), (filename, event) => ))
    //     );

    //     try {
    //         const eventPromises = watchers.map(watcher =>
    //             watcher[Symbol.asyncIterator]().next()
    //         );

    //         while (true) {
    //             const { result: event, index } = await Promise.race(
    //                 eventPromises.map((promise, index) =>
    //                     promise.then(result => ({ result, index }))
    //                 )
    //             );

    //             if (event.done) break;

    //             yield {
    //                 kind: event.value.type === 'rename' ? 'rename' : 'any',
    //                 paths: [event.value.filename || event.value.path]
    //             };

    //             // 为这个监视器重新开始等待下一个事件
    //             eventPromises[index] = watchers[index][Symbol.asyncIterator]().next();
    //         }
    //     } finally {
    //         watchers.forEach(w => w.close());
    //     }
    // }

} satisfies Partial<typeof Deno>);