import { Interface, ReadLineOptions } from './mod';

export function createInterface(options: ReadLineOptions | NodeJS.ReadableStream): Interface {
    return new Interface(options);
}
