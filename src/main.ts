import { installGlobal } from './cjs';
installGlobal(); // allow require()

await import('./webapi/index');
await import('./deno/index');
await import('./module/debug/promise');