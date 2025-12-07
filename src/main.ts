import { installGlobal } from './cjs';
installGlobal(); // allow require()

await import('./webapi/index');
await import('./deno/index');

const entry = Deno.args[0];
if (!entry){
    console.error("No entry point specified");
    Deno.exit(1);
}

await import(Deno.realPathSync(entry));