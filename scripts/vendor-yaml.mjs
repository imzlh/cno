import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const version = '2.9.1';
const integrity = '3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==';
const cache = join(homedir(), '.cache', 'cno-vendor', `yaml-${version}`);
await mkdir(cache, { recursive: true });
const response = await fetch(`https://registry.npmjs.org/yaml/-/yaml-${version}.tgz`);
if (!response.ok) throw new Error(`yaml download failed: ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha512').update(archive).digest('base64') !== integrity) throw new Error('yaml integrity mismatch');
const archivePath = join(cache, 'yaml.tgz');
await writeFile(archivePath, archive);
execFileSync('tar', ['-xzf', archivePath, '-C', cache]);
const source = join(cache, 'package', 'browser', 'dist');
const license = await readFile(join(cache, 'package', 'LICENSE'), 'utf8');
const output = fileURLToPath(new URL('../src/bun/utils/vendor/yaml-parser.ts', import.meta.url));
await mkdir(dirname(output), { recursive: true });
const result = await build({
    stdin: {
        contents: `import { Composer } from './compose/composer.js';
import { Parser } from './parse/parser.js';
export function parseDocuments(source, options) {
    return Array.from(new Composer(options).compose(new Parser().parse(source)));
}`,
        resolveDir: source,
        sourcefile: 'yaml-parser.js',
    },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minifySyntax: true,
    legalComments: 'none',
    write: false,
    metafile: true,
    plugins: [{
        name: 'parser-only',
        setup(builder) {
            builder.onLoad({ filter: /[/\\](?:nodes|doc|schema)[/\\].*\.js$/ }, async ({ path }) => {
                const tree = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
                const transformed = ts.transform(tree, [context => {
                    const visit = node => {
                        if (ts.isClassDeclaration(node) && /(?:nodes[/\\]|yaml-1\.1[/\\]|Document\.js$|Schema\.js$)/.test(path)) {
                            const members = node.members.filter(member => ts.isConstructorDeclaration(member)
                                || node.name?.text === 'Document' && member.name?.getText(tree) === 'setSchema');
                            return ts.factory.updateClassDeclaration(node, node.modifiers, node.name, node.typeParameters,
                                node.heritageClauses, members.map(member => ts.visitEachChild(member, visit, context)));
                        }
                        if ((ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) && /[/\\]schema[/\\]/.test(path)
                            && ['identify', 'createNode', 'stringify'].includes(node.name.getText(tree))) return undefined;
                        return ts.visitEachChild(node, visit, context);
                    };
                    return root => ts.visitNode(root, visit);
                }]);
                const contents = ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]);
                transformed.dispose();
                return { contents };
            });
            builder.onLoad({ filter: /[/\\]stringify[/\\][^/\\]+\.js$/ }, async ({ path }) => {
                const text = await readFile(path, 'utf8');
                const exports = text.match(/export \{([^}]+)\}/)?.[1].split(',').map(value => value.trim()) ?? [];
                return { contents: exports.map(name => `export function ${name}() { throw new Error('YAML parser has no stringifier'); }`).join('\n') };
            });
        },
    }],
});
const bundled = result.outputFiles[0].text.replace(/^\/\/ .*\/package\/browser\/dist\//gm, '// yaml/');
await writeFile(output, `// @ts-nocheck\n// yaml@${version} parser; regenerate: node cno/scripts/vendor-yaml.mjs\n/*\n${license.trim()}\n*/\n${bundled}`);
console.log(`${output}: ${result.outputFiles[0].text.length} bytes; stringifier excluded`);
