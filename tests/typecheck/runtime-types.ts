import { Buffer as NodeBuffer } from 'node:buffer';
import type { Stats } from 'node:fs';
import type { Stats as BareStats } from 'fs';
import type { MessagePort as NodeMessagePort } from 'node:worker_threads';
import { hash as bunHash, spawn as bunSpawn } from 'bun';
import { Database } from 'bun:sqlite';
import type { BunSpawnFunction, BunSpawnOptions, BunSubprocess } from '../../src/bun/process/types';

declare const stats: Stats;
const bareStats: BareStats = stats;
const nodeBuffer: NodeBuffer = NodeBuffer.from('cno');
const nodeBytes: Uint8Array = nodeBuffer;
const nodeVersion: string = process.versions.node;
const denoVersion: string = Deno.version.deno;
const bunVersion: string = Bun.version;
const hashValue: bigint = Bun.hash('cno');
const importedHash: bigint = bunHash('cno');
const child: Bun.Subprocess = bunSpawn(['echo', 'cno']);
declare const localSpawn: BunSpawnFunction;
const localChild: Bun.Subprocess<'ignore', 'pipe', 'inherit'> = localSpawn(['echo', 'cno']);
const officialChild: BunSubprocess<'ignore', 'pipe', 'inherit'> = Bun.spawn(['echo', 'cno']);
const localOptions: BunSpawnOptions<'ignore', 'pipe', 'inherit'> = { stdout: 'pipe' };
const database: Database = new Database(':memory:');
// @ts-expect-error The Node module must resolve to real declarations, not any.
stats.notAStatMember;
// @ts-expect-error The Bun module must resolve to real declarations, not any.
bunHash({ invalid: true });
// @ts-expect-error Bun's spawn command must not accept a number.
bunSpawn(123);

declare const webPort: MessagePort;
declare const nodePort: NodeMessagePort;
nodePort.ref();
// @ts-expect-error Node's MessagePort members must not merge into the Web API.
webPort.ref();

declare const webPerformance: Performance;
// @ts-expect-error Node's performance members must not merge into the Web API.
webPerformance.nodeTiming;

declare const webBlob: Blob;
// @ts-expect-error Bun's Blob extensions must not merge into Deno's Web API.
webBlob.json();
declare const webStream: ReadableStream;
// @ts-expect-error Bun's stream extensions must not merge into Deno's Web API.
webStream.text();

const response: Promise<Response> = fetch(new Request('https://example.com'));
const listener: EventListener = (event: Event) => void event.type;
void [bareStats, nodeBytes, nodeVersion, denoVersion, bunVersion, hashValue,
    importedHash, child, localChild, officialChild, localOptions, database, response, listener];
