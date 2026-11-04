#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Keep the declarations aligned with the APIs this runtime implements.
const version = '2.9.0';
const sha256 = 'bea783df0dc2556b40b3aa8644788400904b4f56e7c45ff112279bfe94faa5bf';
const source = `https://github.com/denoland/deno/releases/download/v${version}/lib.deno.d.ts`;
const destination = fileURLToPath(new URL('../node_modules/.cache/cno-types/lib.deno.d.ts', import.meta.url));

function checksum(contents) {
    return createHash('sha256').update(contents).digest('hex');
}

async function prepareDenoTypes() {
    try {
        if (checksum(await readFile(destination)) === sha256) return;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const response = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        throw new Error(`Unable to download Deno ${version} types: HTTP ${response.status}`);
    }
    const contents = Buffer.from(await response.arrayBuffer());
    if (checksum(contents) !== sha256) {
        throw new Error(`Deno ${version} types failed SHA-256 verification`);
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    console.log(`Prepared Deno ${version} types`);
}

async function prepareNodeTypes() {
    const index = fileURLToPath(new URL('../node_modules/@types/node/index.d.ts', import.meta.url));
    const output = fileURLToPath(new URL('../node_modules/.cache/cno-types/node/index.d.ts', import.meta.url));
    const contents = await readFile(index, 'utf8');
    const webGlobals = /^\/\/\/ <reference path="web-globals\/[^"\r\n]+"\s*\/>\s*$/gm;
    if (!webGlobals.test(contents)) {
        throw new Error('Unexpected @types/node layout: no web-globals references found');
    }

    // Resolve explicit Node type references (including undici's) to this entry
    // point, rather than merging Node's Web API globals into Deno's globals.
    const filtered = contents.replace(webGlobals, '').replace(
        /^(\/\/\/ <reference path=")([^"\r\n]+)("\s*\/>)/gm,
        '$1../../../@types/node/$2$3',
    );
    await writeIfChanged(output, filtered);
}

async function writeIfChanged(path, contents) {
    await mkdir(dirname(path), { recursive: true });
    let previous;
    try {
        previous = await readFile(path, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (previous !== contents) await writeFile(path, contents);
}

async function prepareBunTypes() {
    const source = new URL('../node_modules/bun-types/', import.meta.url);
    const output = new URL('../node_modules/.cache/cno-types/bun-types/', import.meta.url);
    const index = await readFile(new URL('index.d.ts', source), 'utf8');
    const references = [...index.matchAll(/^\/\/\/ <reference path="\.\/([^"\r\n]+)"\s*\/>/gm)];
    const names = references.map((match) => match[1]);
    for (const required of ['globals.d.ts', 'overrides.d.ts', 'deprecated.d.ts', 'bun.ns.d.ts']) {
        if (!names.includes(required)) throw new Error(`Unexpected bun-types layout: missing ${required}`);
    }

    // Keep Bun's internal module types, but not its conflicting Web globals or
    // Node/Web overrides. Preserve other Bun module declarations and Bun itself.
    for (const name of ['globals.d.ts', 'deprecated.d.ts']) {
        const text = await readFile(new URL(name, source), 'utf8');
        const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
        const modules = file.statements.filter((statement) =>
            ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name),
        );
        if (!modules.some((statement) => statement.name.text === 'bun')) {
            throw new Error(`Unexpected bun-types layout: missing bun module in ${name}`);
        }
        await writeIfChanged(fileURLToPath(new URL(name, output)), modules.map((node) => node.getFullText(file)).join('\n'));
    }

    const refs = names.filter((name) => name !== 'overrides.d.ts').map((name) => {
        const path = name === 'globals.d.ts' || name === 'deprecated.d.ts' ? name : `../../../bun-types/${name}`;
        return `/// <reference path="${path}" />`;
    });
    await writeIfChanged(fileURLToPath(new URL('index.d.ts', output)), `/// <reference types="node" />\n${refs.join('\n')}\n`);
}

await Promise.all([prepareDenoTypes(), prepareNodeTypes(), prepareBunTypes()]);
