type PipeRefState = {
    refCount: number;
    refed: boolean;
};

type PipeRefStateRegistry = WeakMap<object, PipeRefState>;

export interface PipeRefLease {
    ref(): void;
    unref(): void;
    release(): void;
}

const evbus = import.meta.use('evbus');
const RUNTIME_NAMESPACE = 'cno.runtime';
const PIPE_REF_STATES_KEY = 'workerPipeRefStates';
const registeredPipeStates = evbus.get<PipeRefStateRegistry>(RUNTIME_NAMESPACE, PIPE_REF_STATES_KEY);
const pipeRefStates = registeredPipeStates ?? new WeakMap<object, PipeRefState>();
if (!registeredPipeStates) evbus.set(RUNTIME_NAMESPACE, PIPE_REF_STATES_KEY, pipeRefStates);

function stateFor(pipe: CModuleWorker.MessagePipe): PipeRefState {
    let state = pipeRefStates.get(pipe);
    if (!state) {
        state = { refCount: 0, refed: true };
        pipeRefStates.set(pipe, state);
    }
    return state;
}

function refresh(pipe: CModuleWorker.MessagePipe, state: PipeRefState): void {
    const shouldRef = state.refCount > 0;
    if (state.refed === shouldRef) return;
    state.refed = shouldRef;
    try {
        if (shouldRef) pipe.ref();
        else pipe.unref();
    } catch {
        // Pipe teardown can race a final lease transition.
    }
}

class MessagePipeRefLease implements PipeRefLease {
    #pipe: CModuleWorker.MessagePipe | undefined;
    #state: PipeRefState;
    #refed: boolean;
    #released = false;

    constructor(pipe: CModuleWorker.MessagePipe, refed: boolean) {
        this.#pipe = pipe;
        this.#state = stateFor(pipe);
        this.#refed = refed;
        if (refed) this.#state.refCount++;
        refresh(pipe, this.#state);
    }

    ref(): void {
        if (this.#released || this.#refed) return;
        const pipe = this.#pipe;
        if (!pipe) return;
        this.#refed = true;
        this.#state.refCount++;
        refresh(pipe, this.#state);
    }

    unref(): void {
        if (this.#released || !this.#refed) return;
        const pipe = this.#pipe;
        if (!pipe) return;
        this.#refed = false;
        this.#state.refCount--;
        refresh(pipe, this.#state);
    }

    release(): void {
        if (this.#released) return;
        this.#released = true;
        const pipe = this.#pipe;
        this.#pipe = undefined;
        if (this.#refed) {
            this.#refed = false;
            this.#state.refCount--;
        }
        if (pipe) refresh(pipe, this.#state);
    }
}

export function createPipeRefLease(
    pipe: CModuleWorker.MessagePipe,
    refed = true,
): PipeRefLease {
    return new MessagePipeRefLease(pipe, refed);
}
