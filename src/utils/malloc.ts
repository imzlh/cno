export function malloc(ctrl: ReadableStreamDefaultController | ReadableByteStreamController){
    const desire = ctrl.desiredSize ?? 1024;
    if (desire < 1024) return new Uint8Array(1024);
    return new Uint8Array(desire);
}