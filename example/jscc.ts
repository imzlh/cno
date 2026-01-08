for (const arg of Deno.args) {
    const src = Deno.readTextFileSync(arg);
    const bin = CNO.engine.compileModule(src, { name: Deno.realPathSync(arg) });
    Deno.writeFileSync(arg + ".jsc", bin);
}