// compile.js — TypeScript compiler for circu.js
//
// Single:  compile.js <input.ts> <name:node:xxx> <output.jsc>
// Batch:   compile.js --all          # compile all src/node/**/*.ts -> ~/.cts/node/
// Clean:   compile.js --all --clean  # remove stale outputs first
// @ts-nocheck - cts native
import { transform } from "sucrase";
import { join, normalize } from "../src/utils/path.ts";

const os = import.meta.use('os');
const fs = import.meta.use('fs');
const console = import.meta.use('console');
const engine = import.meta.use('engine');
const smap = import.meta.use('sourcemap');

engine.onEvent((e, r) => {
    if (e == engine.EventType.UNHANDLED_REJECTION)
        console.error('Uncaught (in promise):', r[1]);
    return true;
});

// ── Helpers ────────────────────────────────────────────────────────────────

const nodeModulesDir = os.cwd + '/src/node';
const dstBase = os.homeDir + '/.cts/node';

function resolveNodeModule(specifier: string) {
    const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
    if (!/[a-z]\/[a-z]/.test(name) && name != 'index') {
        return `${nodeModulesDir}/${name}/index.ts`;
    } else {
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

// Walk directory recursively, yielding relative paths
function* walkDir(dir: string, prefix = ''): Generator<string> {
    const entries = fs.readdir(dir);
    for (const name of entries) {
        const full = dir + '/' + name;
        const rel = prefix ? prefix + '/' + name : name;
        const st = fs.stat(full);
        if (st.isDirectory) {
            yield* walkDir(full, rel);
        } else if (name.endsWith('.ts')) {
            yield rel;
        }
    }
}

// Ensure parent directory exists
function mkdirp(dir: string) {
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
        cur += '/' + p;
        try { fs.mkdir(cur, 0o755); } catch { /* exists */ }
    }
}

// ── Module loader (shared across all compilations) ─────────────────────────

let loaderSetup = false;
function setupModuleLoader() {
    if (loaderSetup) return;
    loaderSetup = true;
    engine.onModule({
        resolve: (specifier, parent) => {
            if (specifier.includes(':')) return specifier;
            if (parent.startsWith('node:')) parent = parent.substring(5);
            const path = joinPaths(parent, specifier);
            console.debug(`RESOLVE ${specifier}(p=${parent}) -> ${path}`);
            return 'node:' + path;
        },
        load: (modname) => {
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
}

// ── Compile one file ───────────────────────────────────────────────────────

function compileOne(src: string, name: string, dst: string): boolean {
    if (!fs.exists(src)) {
        console.error(`SKIP  ${name}: source not found: ${src}`);
        return false;
    }
    try {
        // Incremental: skip if dst exists and is newer than src
        const _srcStat = fs.stat(src);
        try {
            const dstStat = fs.stat(dst);
            if (dstStat.lastModified >= _srcStat.lastModified) {
                console.log(`SKIP  ${name} (up to date)`);
                return true;
            }
        } catch { /* dst doesn't exist */ }

        const source = engine.decodeString(fs.readFile(src));
        const transformed = transform(source, {
            filePath: name,
            transforms: ['typescript'],
            injectCreateRequireForImportRequire: false,
            disableESTransforms: true
        });
        smap.load(name, transformed.sourceMap);
        const compiled = new engine.Module(transformed.code, name).dump();

        // Ensure output directory exists
        const dstDir = dst.substring(0, dst.lastIndexOf('/'));
        mkdirp(dstDir);

        fs.writeFile(dst, compiled);
        console.log(`OK    ${name}`);
        return true;
    } catch (e) {
        console.error(`FAIL  ${name}: ${e.message || e}`);
        return false;
    }
}

// ── Clean stale outputs ────────────────────────────────────────────────────

function cleanStale(): number {
    let removed = 0;
    try {
        const dstEntries = fs.readdir(dstBase);
        for (const entry of dstEntries) {
            walkAndClean(dstBase + '/' + entry, nodeModulesDir + '/' + entry);
        }
    } catch { /* dstBase doesn't exist */ }
    return removed;

    function walkAndClean(dstPath: string, srcPath: string) {
        let dstStat;
        try { dstStat = fs.stat(dstPath); } catch { return; }

        if (dstStat.isDirectory) {
            // Check if corresponding src directory exists
            let srcStat;
            try { srcStat = fs.stat(srcPath); } catch {
                // Source dir removed — remove entire dst subtree
                rmrf(dstPath);
                removed++;
                return;
            }
            let dstEntries;
            try { dstEntries = fs.readdir(dstPath); } catch { return; }
            for (const e of dstEntries) {
                walkAndClean(dstPath + '/' + e, srcPath + '/' + e);
            }
            // Remove empty directory
            try {
                const remaining = fs.readdir(dstPath);
                if (remaining.length === 0) {
                    fs.rmdir(dstPath);
                }
            } catch { /* ignore */ }
        } else if (dstStat.isFile) {
            // Check if corresponding .ts source exists
            const srcTs = srcPath.replace(/\.ts\.jsc$/, '.ts');
            if (!fs.exists(srcTs)) {
                fs.unlink(dstPath);
                removed++;
            }
        }
    }

    function rmrf(path: string) {
        try {
            const st = fs.stat(path);
            if (st.isDirectory) {
                for (const e of fs.readdir(path)) {
                    rmrf(path + '/' + e);
                }
                fs.rmdir(path);
            } else {
                fs.unlink(path);
            }
        } catch { /* ignore */ }
    }
}

// ── Main ───────────────────────────────────────────────────────────────────

const args = os.args.slice(2);
const doClean = args.includes('--clean');
const doAll = args[0] === '--all' || (args[0] === '--clean' && args[1] === '--all');

if (doClean) {
    const n = cleanStale();
    if (n > 0) console.log(`Cleaned ${n} stale output(s)`);
}

// grow stack size
engine.setMaxStackSize(6 * 1024 * 1024);

if (doAll) {
    setupModuleLoader();

    // Ensure dst base exists
    mkdirp(dstBase);

    let ok = 0, fail = 0;

    for (const rel of walkDir(nodeModulesDir)) {
        const src = nodeModulesDir + '/' + rel;
        const baseName = rel.replace(/\.ts$/, '');
        const name = 'node:' + baseName.replace(/\/index$/, '');
        const dst = dstBase + '/' + baseName + '.ts.jsc';

        if (compileOne(src, name, dst)) {
            // Count as ok or skipped based on output
            ok++;
        } else {
            fail++;
        }
    }

    console.log(`\nDone: ${ok} compiled, ${fail} failed`);
    if (fail > 0) os.exit(1);

} else {
    // Single-file mode (backward compatible)
    const file = args[0];
    const name = args[1]?.replace(/\/index$/, '');
    const dist = args[2];

    if (!file || !fs.exists(file)) {
        console.error(`File not found: ${file}`);
        os.exit(1);
    }
    if (!dist) {
        console.error('No output file specified');
        os.exit(1);
    }

    setupModuleLoader();
    if (!compileOne(file, name, dist)) os.exit(1);
}
