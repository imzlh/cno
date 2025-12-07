const crypto = import.meta.use('crypto');
const engine = import.meta.use('engine');
const text = import.meta.use('text');
const os = import.meta.use('os');
const fs = import.meta.use('fs');
const timer = import.meta.use('timers');

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
    fs.write(os.STDOUT_FILENO, engine.encodeString(msg ?? '? '));
    let buf = new Uint8Array(1024);
    let i = 0;
    while(true){
        const n = fs.read(os.STDIN_FILENO, buf);
        if(n === 0) break;
        for(let j = 0; j < n; j++) {
            if(buf[j] === 10) {
                const s = engine.decodeString(buf.subarray(0, j));
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