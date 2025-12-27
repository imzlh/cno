/**
 * Enhance Promise debugging experience.
 */

const engine = import.meta.use('engine');

// @ts-ignore
globalThis.addEventListener('promise', function(ev: CustomEvent) {
    const [ promise, state, parent ]: CModuleEngine.GlobalEvents['promise']
        = ev.detail;
    if (state == engine.PromiseState.CONSTRUCT) {
        // trace
        const stack = new Error().stack;
        if (!stack) return;
        Reflect.set(promise, '__stack', stack);
        console.log(`Promise created: ${promise}`);
    } else if (state == engine.PromiseState.FULFILLED) {
        try {
            engine.promiseResult(promise);
            return; // no error
        } catch (e) {
            if (typeof e == 'object' && e instanceof Error){
                const stack = Reflect.get(promise, '__stack') as string;
                if (e.stack?.trim() !== stack.trim()) {
                    console.log(`Promise fulfilled: ${promise}, prev_stack: ${stack}`);
                    e.stack = `${e.stack}\n ------ promise ------ \n${stack}`;
                }
            }
        }
    }
})