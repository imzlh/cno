// compile.js - TypeScript compiler for denort
// Usage: compile.js <input.ts> <name> <output.jsc>
// @ts-nocheck - we are using native modules

import { transform } from "sucrase";
import { join, normalize } from "../src/utils/path";

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const sys = import.meta.use('sys');
const console = import.meta.use('console');
const engine = import.meta.use('engine');
const smap = import.meta.use('sourcemap');

const file = sys.args[1];
const name = sys.args[2]?.replace(/\/index$/, '');
const dist = sys.args[3];

if (!file || !fs.exists(file)) {
    console.error(`File not found: ${file}`);
    os.exit(1);
}
if (!dist) {
    console.error('No output file specified');
    os.exit(1);
}

engine.onEvent((e, r) => {
    if (e == engine.EventType.UNHANDLED_REJECTION)
        console.error('Uncaught (in promise):', r[1]);
    return true;
})

const nodeModulesDir = os.cwd + '/src/node';
function resolveNodeModule(specifier: string) {
    // Remove 'node:' prefix
    const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    if (!/[a-z]\/[a-z]/.test(name) && name != 'index') {
        // Single part: fs -> fs/index.ts
        return `${nodeModulesDir}/${name}/index.ts`;
    } else {
        // Multiple parts: fs/promises -> fs/promises.ts
        return `${nodeModulesDir}/${name}.ts`;
    }
}

function joinPaths(base: string, path: string) {
    base = base.replace('\\', '/');
    path = path.replace('\\', '/');
    if (base == 'index') return normalize(path);

    base = base.includes('/') ? base.substring(0, base.lastIndexOf('/')) : base;
    return join(base, path);
}

// Setup module loader hooks
engine.onModule({
    resolve: (specifier, parent) => {
        // Return node: protocol for node modules
        if (specifier.includes(':')) {
            return specifier;
        }

        if (parent.startsWith('node:')) {
            parent = parent.substring(5);
        }
        
        const path = joinPaths(parent, specifier);
        console.debug(`RESOLVE ${specifier}(p=${parent}) -> ${path}`);
        return 'node:' + path;
    },

    load: (modname) => {
        // Load actual file for node: modules
        if (modname.startsWith('node:')) {
            const localPath = resolveNodeModule(modname);
            console.debug(`LOAD ${modname} -> ${localPath}`);
            const source = engine.decodeString(fs.readFile(localPath));
            const transformed = transform(source, {
                filePath: modname,
                transforms: ['typescript'],
                injectCreateRequireForImportRequire: false,
                disableESTransforms: true
            });
            smap.load(modname, transformed.sourceMap);
            return new engine.Module(transformed.code, modname);
        }

        return 'export {}';  
    }
});

// Read and compile main file
const source = engine.decodeString(fs.readFile(file));
const transformed = transform(source, {
    filePath: name,
    transforms: ['typescript'],
    injectCreateRequireForImportRequire: false,
    disableESTransforms: true
});
smap.load(name, transformed.sourceMap);
const compiled = new engine.Module(transformed.code, name).dump();

// Write output
fs.writeFile(dist, compiled);
console.log(`COMPILE ${name} -> ${dist}`);
