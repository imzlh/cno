const libc = Deno.dlopen("libc.so.6", {
    strlen: {
        parameters: ["pointer"],
        result: "usize",
    },
    puts: {
        parameters: ["pointer"],
        result: "i32",
    },
    malloc: {
        parameters: ["usize"],
        result: "pointer",
    },
    free: {
        parameters: ["pointer"],
        result: "void",
    },
    getpid: {
        parameters: [],
        result: "i32",
    },
    abs: {
        parameters: ["i32"],
        result: "i32",
    },
    atoi: {
        parameters: ["pointer"],
        result: "i32",
    },
});

console.log("libc loaded successfully");

const pid = libc.symbols.getpid();
console.log("Current PID:", pid);

const absResult = libc.symbols.abs(-42);
console.log("abs(-42) =", absResult);

const str = new TextEncoder().encode("Hello, FFI!\0");
const strPtr = Deno.UnsafePointer.of(str);
if (strPtr) {
    const len = libc.symbols.strlen(strPtr);
    console.log("strlen('Hello, FFI!') =", len);
    
    libc.symbols.puts(strPtr);
}

const numStr = new TextEncoder().encode("12345\0");
const numStrPtr = Deno.UnsafePointer.of(numStr);
if (numStrPtr) {
    const num = libc.symbols.atoi(numStrPtr);
    console.log("atoi('12345') =", num);
}

const mem = libc.symbols.malloc(100n);
console.log("malloc(100) =", mem ? "pointer allocated" : "null");

if (mem) {
    const view = new Deno.UnsafePointerView(mem);
    const buf = new Uint8Array(10);
    for (let i = 0; i < 10; i++) {
        buf[i] = 65 + i;
    }
    view.copyInto(buf);
    
    const readBuf = view.getArrayBuffer(10);
    console.log("Written and read back:", new TextDecoder().decode(readBuf));
    
    libc.symbols.free(mem);
    console.log("memory freed");
}

libc.close();
console.log("libc closed");
