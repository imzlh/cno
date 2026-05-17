/**
 * Node.js domain module (deprecated stub)
 * Domain-based error handling
 */

import { EventEmitter } from '../events';

export class Domain extends EventEmitter {
    members: any[] = [];

    run(fn: Function): void { fn(); }
    bind<T extends Function>(fn: T): T { return fn; }
    intercept<T extends Function>(fn: T): T { return fn; }

    add(_emitter: EventEmitter | Timer): void {}
    remove(_emitter: EventEmitter | Timer): void {}
    dispose(): void { this.emit('dispose'); }

    enter(): void {}
    exit(): void {}
}

export function create(): Domain {
    return new Domain();
}

export const active: Domain | null = null;
