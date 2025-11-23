import './webapi/core';
import './deno/deno';

const entry = Deno.args.splice(1, 1)[0];
if (!entry){
    console.error("No entry point specified");
    Deno.exit(1);
}

await import(Deno.realPathSync(entry));