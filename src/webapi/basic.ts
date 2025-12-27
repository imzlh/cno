import { assert } from "../utils/assert";

const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const text = import.meta.use('text');
const os = import.meta.use('os');
const fs = import.meta.use('fs');
const timer = import.meta.use('timers');

assert(text, 'text module is not available');

globalThis.atob = function(str) {
    const dec = crypto.base64Decode(str);
    return engine.decodeString(dec);
}

globalThis.btoa = function(str) {
    const enc = engine.encodeString(str);
    return crypto.base64Encode(enc);
}

globalThis.alert = function(msg) {
    console.log(msg);
}

globalThis.prompt = function(msg) {
    fs.setBlocking(os.STDIN_FILENO, true);
    fs.setBlocking(os.STDOUT_FILENO, true);
    assert(fs.write(os.STDOUT_FILENO, engine.encodeString(msg ? msg + ' ' : '? ')), "write() operation failed");
    let buf = new Uint8Array(1024);
    let i = 0;
    const LF = engine.encodeString('\n')[0];
    while(true){
        const n = fs.read(os.STDIN_FILENO, buf);
        if(!n) break;
        for(let j = 0; j < n; j++) {
            if(buf[j] === LF) {
                const s = engine.decodeString(buf.subarray(0, j));
                fs.setBlocking(os.STDIN_FILENO, false);
                fs.setBlocking(os.STDOUT_FILENO, false);
                return s;
            }
        }
        if(i + n > buf.length) {
            const newbuf = new Uint8Array(buf.length * 2);
            newbuf.set(buf);
            buf = newbuf;
        }
        buf.set(buf.subarray(n), i);
        i += n;
    }
    fs.setBlocking(os.STDIN_FILENO, false);
    fs.setBlocking(os.STDOUT_FILENO, false);
    return null;
}

globalThis.confirm = function(msg) {
    const s = prompt(msg + ' (y/n)');
    return s === 'y' || s === 'Y';
}

globalThis.TextEncoder = text.Encoder;
globalThis.TextDecoder = text.Decoder;

globalThis.setTimeout = function(cb, timeout, ...args) {
    if (typeof cb == 'string') {
        throw new Error('string argument is not allowed for setTimeout for security reasons.');
    }
    return timer.setTimeout(() => {
        cb(...args);
    }, timeout ?? 0);
}
globalThis.clearTimeout = globalThis.clearInterval = function(id) {
    if (!id) return;
    timer.clearTimeout(id);
}
globalThis.setInterval = function(cb, timeout, ...args) {
    if (typeof cb == 'string') {
        throw new Error('string argument is not allowed for setTimeout for security reasons.');
    }
    return timer.setInterval(() => {
        cb(...args);
    }, timeout ?? 0);
};

globalThis.structuredClone = function(v, opt){
    return engine.deserialize(engine.serialize(v));
}

globalThis.reportError = function(e) {
    globalThis.dispatchEvent(new CustomEvent('error', {
        detail: e
    }));
}

// @ts-ignore
globalThis.WebTransport = function(){
    throw new Error('Unsupported');
}

globalThis.close = function(){
    os.exit(0);
}