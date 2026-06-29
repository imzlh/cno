import { Interface, type ReadLineOptions } from './mod';

export type PromisesInterface = Interface & {
    question(query: string, options?: { signal?: AbortSignal }): Promise<string>;
};

export function createInterface(options: ReadLineOptions | NodeJS.ReadableStream): PromisesInterface {
    const rl = new Interface(options as ReadLineOptions) as PromisesInterface;
    const baseQuestion = rl.question.bind(rl);

    rl.question = (query: string, options?: { signal?: AbortSignal }): Promise<string> => {
        if (options?.signal?.aborted) {
            return Promise.reject(new Error('The operation was aborted'));
        }
        return new Promise<string>((resolve, reject) => {
            let settled = false;
            const onAbort = (): void => finish(() => reject(new Error('The operation was aborted')));
            const finish = (fn: () => void): void => {
                if (settled) return;
                settled = true;
                options?.signal?.removeEventListener('abort', onAbort);
                fn();
            };
            if (options?.signal) {
                options.signal.addEventListener('abort', onAbort, { once: true });
            }
            baseQuestion(query, (answer: string) => finish(() => resolve(answer)));
        });
    };

    return rl;
}
