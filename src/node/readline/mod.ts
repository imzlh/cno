/**
 * Node.js readline module (stub)
 * Readline for interactive terminal input
 */

import { EventEmitter } from '../events';

export interface ReadLineOptions {
    input: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    completer?: (line: string) => [string[], string];
    terminal?: boolean;
    historySize?: number;
    removeHistoryDuplicates?: boolean;
    prompt?: string;
    crlfDelay?: number;
    escapeCodeTimeout?: number;
    tabSize?: number;
    signal?: AbortSignal;
}

export class Interface extends EventEmitter {
    getTerminal(): boolean { return false; }
    setPrompt(_prompt: string): void {}
    prompt(_preserveCursor?: boolean): void {}
    question(query: string, callback: (answer: string) => void): void { callback(''); }
    close(): void { this.emit('close'); }
    pause(): this { return this; }
    resume(): this { return this; }
    write(_data: string | Buffer, _key?: { ctrl?: boolean; meta?: boolean; shift?: boolean; name: string }): void {}
    get cursorPos(): { rows: number; cols: number } { return { rows: 0, cols: 0 }; }
}

export function createInterface(options: ReadLineOptions | NodeJS.ReadableStream): Interface {
    return new Interface();
}

export function emitKeypressEvents(_stream: NodeJS.ReadableStream, _interface?: Interface): void {}

export function clearLine(_stream: NodeJS.WritableStream, _dir: -1 | 0 | 1, _callback?: () => void): void {}
export function clearScreenDown(_stream: NodeJS.WritableStream, _callback?: () => void): void {}
export function cursorTo(_stream: NodeJS.WritableStream, x: number, y?: number, _callback?: () => void): void {}
export function moveCursor(_stream: NodeJS.WritableStream, dx: number, dy: number, _callback?: () => void): void {}
