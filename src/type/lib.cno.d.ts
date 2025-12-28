/**
 * CNO private api
 * access to private functions and variables powered by circu.js
 */

declare namespace CNO {
    export interface OpenptyOptions {
        cols?: number;
        rows?: number;
        name?: string;
        cwd?: string;
        env?: Record<string, string>;
        argv?: string[];
    }

    export type Signal =
        | 'SIGHUP'
        | 'SIGINT'
        | 'SIGQUIT'
        | 'SIGILL'
        | 'SIGTRAP'
        | 'SIGABRT'
        | 'SIGBUS'
        | 'SIGFPE'
        | 'SIGKILL'
        | 'SIGUSR1'
        | 'SIGSEGV'
        | 'SIGUSR2'
        | 'SIGPIPE'
        | 'SIGALRM'
        | 'SIGTERM'
        | 'SIGSTKFLT'
        | 'SIGCHLD'
        | 'SIGCONT'
        | 'SIGSTOP'
        | 'SIGTSTP'
        | 'SIGBREAK'
        | 'SIGTTIN'
        | 'SIGTTOU'
        | 'SIGURG'
        | 'SIGXCPU'
        | 'SIGXFSZ'
        | 'SIGVTALRM'
        | 'SIGPROF'
        | 'SIGWINCH'
        | 'SIGPOLL'
        | 'SIGLOST'
        | 'SIGPWR'
        | 'SIGINFO'
        | 'SIGSYS';

    export interface PtyPipe {
        readable: ReadableStream;
        writable: WritableStream;
        resize: (cols: number, rows: number) => void;
        kill: (signal: Signal) => void;
    }

    export function openpty(options: OpenptyOptions): Promise<PtyPipe>;
}