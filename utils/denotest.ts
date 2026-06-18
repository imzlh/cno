const console = import.meta.use('console');
console.log('Start scan and running deno tests');
console.log('Behavior is same as: cargo run --bin deno -- test --allow-all --location=http://js-unit-tests/foo/bar .');

const flist = Deno.readDirSync('.');
for (const file of flist) {
    if (file.name.endsWith('.ts') && file.isFile) try {
        console.info(`Running ${file.name}`);
        await import(Deno.realPathSync(file.name));
    } catch (e) {
        console.error(`  fail ${file.name}`, e, (e as Error).stack);
    }
}

console.log('Now, starting all tests.');
// @ts-ignore - cno private function
Deno.__startTest();