#!/usr/bin/env -S deno run -A --unstable-kv

const console = import.meta.use('console');
type KvKeyPart = string | number | bigint | boolean | Uint8Array;
type KvKey = readonly KvKeyPart[];

type SourceRow = {
  key: Uint8Array | string;
  value: Uint8Array;
  versionstamp: string;
  expire_at: number | null;
};

type DecodeRequest = {
  index: number;
  valueHex: string;
};

type DecodeResponse =
  | {
      index: number;
      ok: true;
      encoded: PortableValue;
    }
  | {
      index: number;
      ok: false;
      error: string;
    };

type PortableTagged =
  | { __cno_kv_portable__: "undefined" }
  | { __cno_kv_portable__: "bigint"; value: string }
  | { __cno_kv_portable__: "Date"; value: string }
  | { __cno_kv_portable__: "RegExp"; source: string; flags: string }
  | { __cno_kv_portable__: "Map"; value: [PortableValue, PortableValue][] }
  | { __cno_kv_portable__: "Set"; value: PortableValue[] }
  | { __cno_kv_portable__: "ArrayBuffer"; value: string }
  | { __cno_kv_portable__: "TypedArray"; kind: string; value: string }
  | { __cno_kv_portable__: "DataView"; value: string };

type PortableValue =
  | null
  | string
  | number
  | boolean
  | PortableTagged
  | PortableValue[]
  | { [key: string]: PortableValue };

type CliOptions = {
  source: string;
  target: string;
  cnoBin: string;
  batchSize: number;
  dryRun: boolean;
};

const HELPER_FLAG = "--decode-helper";
const PORTABLE_TAG = "__cno_kv_portable__";

if (Deno.args[0] === HELPER_FLAG) {
  await runDecodeHelper(Deno.args[1]);
} else {
  await runMain();
}

async function runMain(): Promise<void> {
  const options = parseArgs(Deno.args);
  const scriptPath = fromFileUrl(new URL(import.meta.url));
  const sourcePath = normalizeCnoKvPath(options.source);

  ensureFileExists(sourcePath, "source cno kv");
  ensureResolvableCommand(options.cnoBin, "cno executable");

  const sqlite = await loadSqlite();
  const db = new sqlite.DatabaseSync(sourcePath, { readonly: true });

  try {
    if (typeof Deno.openKv !== "function") {
      throw new Error("Deno.openKv is unavailable. Run this script with --unstable-kv.");
    }

    const total = Number(db.prepare("SELECT COUNT(*) AS count FROM kv_entries").get()?.count ?? 0);
    const targetKv = options.dryRun ? null : await Deno.openKv(options.target);

    let offset = 0;
    let migrated = 0;
    let skippedExpired = 0;
    let failed = 0;

    console.log(`Source: ${sourcePath}`);
    console.log(`Target: ${options.target}`);
    console.log(`CNO: ${options.cnoBin}`);
    console.log(`Rows: ${total}`);
    if (options.dryRun) console.log("Mode: dry-run");

    while (true) {
      const rows = db.prepare(
        "SELECT key, value, versionstamp, expire_at FROM kv_entries ORDER BY rowid ASC LIMIT ? OFFSET ?",
      ).all(options.batchSize, offset) as SourceRow[];

      if (rows.length === 0) break;
      offset += rows.length;

      const activeRows: Array<{
        key: KvKey;
        valueHex: string;
        expireAt: number | null;
        versionstamp: string;
      }> = [];

      const now = Date.now();
      for (const row of rows) {
        if (row.expire_at !== null && row.expire_at <= now) {
          skippedExpired++;
          continue;
        }

        activeRows.push({
          key: decodeSourceKey(row.key),
          valueHex: bytesToHex(toUint8Array(row.value)),
          expireAt: row.expire_at,
          versionstamp: row.versionstamp,
        });
      }

      if (activeRows.length === 0) continue;

      const decoded = await decodeBatchWithCno(
        options.cnoBin,
        scriptPath,
        activeRows.map((row, index) => ({ index, valueHex: row.valueHex })),
      );

      for (const item of decoded) {
        const row = activeRows[item.index];
        if (!row) {
          failed++;
          console.error(`Decode returned out-of-range index: ${item.index}`);
          continue;
        }

        if (!item.ok) {
          failed++;
          console.error(
            `Decode failed for key ${formatKey(row.key)} (versionstamp ${row.versionstamp}): ${item.error}`,
          );
          continue;
        }

        const value = revivePortable(item.encoded);
        if (!options.dryRun && targetKv) {
          const expireIn = row.expireAt === null ? undefined : Math.max(1, row.expireAt - Date.now());
          await targetKv.set(row.key, value, expireIn === undefined ? undefined : { expireIn });
        }
        migrated++;
      }

      console.log(`Progress: ${Math.min(offset, total)}/${total} scanned, ${migrated} migrated, ${failed} failed`);
    }

    targetKv?.close();

    console.log("");
    console.log(`Done: ${migrated} migrated, ${skippedExpired} expired skipped, ${failed} failed`);
    console.log("Note: Deno KV versionstamps and created_at cannot be preserved through the public API.");

    if (failed > 0) Deno.exit(1);
  } finally {
    db.close();
  }
}

async function runDecodeHelper(requestPath?: string): Promise<void> {
  if (!requestPath) {
    console.error("Missing decode request path");
    Deno.exit(1);
  }

  const { deserializeValue } = await import("../src/deno/kv/types.ts");
  const payload = JSON.parse(await Deno.readTextFile(requestPath)) as DecodeRequest[];

  const out: DecodeResponse[] = [];
  for (const item of payload) {
    try {
      const raw = hexToBytes(item.valueHex);
      const value = deserializeValue(raw);
      out.push({
        index: item.index,
        ok: true,
        encoded: toPortable(value),
      });
    } catch (error) {
      out.push({
        index: item.index,
        ok: false,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
  }

  console.log(JSON.stringify(out));
}

async function loadSqlite(): Promise<{ DatabaseSync: new (path: string, options?: { readonly?: boolean }) => {
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): unknown[];
  };
  close(): void;
} }> {
  try {
    return await import("node:sqlite");
  } catch (error) {
    throw new Error(
      `Failed to load node:sqlite. This script currently requires Deno 2 with node:sqlite support.\n${String(error)}`,
    );
  }
}

function parseArgs(args: string[]): CliOptions {
  let source = "";
  let target = "";
  let cnoBin = "";
  let batchSize = 200;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--source":
      case "-s":
        source = args[++i] ?? "";
        break;
      case "--target":
      case "-t":
        target = args[++i] ?? "";
        break;
      case "--cno":
        cnoBin = args[++i] ?? "";
        break;
      case "--batch-size":
        batchSize = Number(args[++i] ?? "200");
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        Deno.exit(0);
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (!source) source = arg;
        else if (!target) target = arg;
        else throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  if (!source || !target) {
    printHelp();
    throw new Error("Both source and target paths are required");
  }

  if (!cnoBin) {
    cnoBin = detectCnoBin();
  }

  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid --batch-size: ${batchSize}`);
  }

  return { source, target, cnoBin, batchSize, dryRun };
}

function printHelp(): void {
  console.log(`Usage:
  deno run -A --unstable-kv cno/utils/migrate_cno_kv_to_deno.ts --source <source.cnodb> --target <deno-kv.db> [--cno <cno.exe>] [--batch-size 200] [--dry-run]

Examples:
  deno run -A --unstable-kv cno/utils/migrate_cno_kv_to_deno.ts -s .deno/kv.db.cnodb -t .deno/deno-kv.db
  deno run -A --unstable-kv cno/utils/migrate_cno_kv_to_deno.ts .deno/kv.db .deno/deno-kv.db --cno D:\\project\\cno-cli\\build\\stage\\cno.exe
`);
}

function detectCnoBin(): string {
  const envBin = Deno.env.get("CNO_BIN");
  if (envBin) return envBin;

  const candidates = [
    fromFileUrl(new URL("../../build/stage/cno.exe", import.meta.url)),
    fromFileUrl(new URL("../../build/stage/cno", import.meta.url)),
    "cno",
  ];

  for (const candidate of candidates) {
    try {
      Deno.statSync(candidate);
      return candidate;
    } catch {
      // Keep checking.
    }
  }

  return candidates[candidates.length - 1];
}

function normalizeCnoKvPath(path: string): string {
  return path.endsWith(".cnodb") ? path : `${path}.cnodb`;
}

function ensureFileExists(path: string, label: string): void {
  try {
    Deno.statSync(path);
  } catch {
    throw new Error(`Unable to find ${label}: ${path}`);
  }
}

function ensureResolvableCommand(command: string, label: string): void {
  if (!/[\\/.:]/.test(command)) return;
  ensureFileExists(command, label);
}

async function decodeBatchWithCno(
  cnoBin: string,
  scriptPath: string,
  payload: DecodeRequest[],
): Promise<DecodeResponse[]> {
  const requestPath = await Deno.makeTempFile({ suffix: ".cno-kv-migrate.json" });

  try {
    await Deno.writeTextFile(requestPath, JSON.stringify(payload));

    const command = new Deno.Command(cnoBin, {
      args: [scriptPath, HELPER_FLAG, requestPath],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr).trim();
      throw new Error(stderr || `cno helper exited with code ${result.code}`);
    }

    const stdout = new TextDecoder().decode(result.stdout).trim();
    return JSON.parse(stdout) as DecodeResponse[];
  } finally {
    try {
      await Deno.remove(requestPath);
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function toPortable(value: unknown, seen = new WeakSet<object>()): PortableValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined) return { [PORTABLE_TAG]: "undefined" };
  if (typeof value === "bigint") return { [PORTABLE_TAG]: "bigint", value: value.toString() };
  if (typeof value === "symbol") {
    throw new TypeError(`Unsupported symbol value: ${String(value.description ?? value)}`);
  }
  if (typeof value === "function") {
    throw new TypeError("Functions cannot be migrated");
  }

  if (value instanceof Date) return { [PORTABLE_TAG]: "Date", value: value.toISOString() };
  if (value instanceof RegExp) {
    return { [PORTABLE_TAG]: "RegExp", source: value.source, flags: value.flags };
  }
  if (value instanceof Map) {
    if (seen.has(value)) throw new TypeError("Circular references are not supported");
    seen.add(value);
    const out: PortableTagged = {
      [PORTABLE_TAG]: "Map",
      value: Array.from(value.entries(), ([key, inner]) => [toPortable(key, seen), toPortable(inner, seen)]),
    };
    seen.delete(value);
    return out;
  }
  if (value instanceof Set) {
    if (seen.has(value)) throw new TypeError("Circular references are not supported");
    seen.add(value);
    const out: PortableTagged = {
      [PORTABLE_TAG]: "Set",
      value: Array.from(value.values(), (inner) => toPortable(inner, seen)),
    };
    seen.delete(value);
    return out;
  }
  if (value instanceof ArrayBuffer) {
    return { [PORTABLE_TAG]: "ArrayBuffer", value: bytesToHex(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      return { [PORTABLE_TAG]: "DataView", value: bytesToHex(viewToBytes(value)) };
    }
    return {
      [PORTABLE_TAG]: "TypedArray",
      kind: value.constructor.name,
      value: bytesToHex(viewToBytes(value)),
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Circular references are not supported");
    seen.add(value);
    const out = value.map((item) => toPortable(item, seen));
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) throw new TypeError("Circular references are not supported");
    seen.add(value as object);

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`Unsupported object prototype: ${value?.constructor?.name ?? "<unknown>"}`);
    }

    const out: Record<string, PortableValue> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toPortable(inner, seen);
    }
    seen.delete(value as object);
    return out;
  }

  throw new TypeError(`Unsupported value type: ${typeof value}`);
}

function revivePortable(value: PortableValue): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => revivePortable(item));
  }
  if (PORTABLE_TAG in value) {
    const tagged = value as PortableTagged;
    switch (tagged[PORTABLE_TAG]) {
      case "undefined":
        return undefined;
      case "bigint":
        return BigInt(tagged.value);
      case "Date":
        return new Date(tagged.value);
      case "RegExp":
        return new RegExp(tagged.source, tagged.flags);
      case "Map":
        return new Map(tagged.value.map(([key, inner]) => [revivePortable(key), revivePortable(inner)]));
      case "Set":
        return new Set(tagged.value.map((item) => revivePortable(item)));
      case "ArrayBuffer":
        return hexToBytes(tagged.value).buffer;
      case "DataView": {
        const bytes = hexToBytes(tagged.value);
        return new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      }
      case "TypedArray":
        return reviveTypedArray(tagged.kind, hexToBytes(tagged.value));
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = revivePortable(inner);
  }
  return out;
}

function reviveTypedArray(kind: string, bytes: Uint8Array): ArrayBufferView {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  switch (kind) {
    case "Uint8Array":
      return new Uint8Array(buffer);
    case "Int8Array":
      return new Int8Array(buffer);
    case "Uint8ClampedArray":
      return new Uint8ClampedArray(buffer);
    case "Uint16Array":
      return new Uint16Array(buffer);
    case "Int16Array":
      return new Int16Array(buffer);
    case "Uint32Array":
      return new Uint32Array(buffer);
    case "Int32Array":
      return new Int32Array(buffer);
    case "Float32Array":
      return new Float32Array(buffer);
    case "Float64Array":
      return new Float64Array(buffer);
    case "BigUint64Array":
      return new BigUint64Array(buffer);
    case "BigInt64Array":
      return new BigInt64Array(buffer);
    default:
      throw new TypeError(`Unsupported typed array kind: ${kind}`);
  }
}

function decodeSourceKey(raw: Uint8Array | string): KvKey {
  if (typeof raw === "string") return deserializeLegacyKey(raw);
  return deserializeKey(toUint8Array(raw));
}

function deserializeLegacyKey(rawKey: string): KvKey {
  return JSON.parse(rawKey, (_key, value) => {
    if (value && typeof value === "object" && "__kv_type" in value) {
      const tagged = value as { __kv_type: string; value: unknown };
      switch (tagged.__kv_type) {
        case "bigint":
          return BigInt(String(tagged.value));
        case "Uint8Array":
          return new Uint8Array(tagged.value as number[]);
      }
    }
    return value;
  }) as KvKey;
}

function deserializeKey(rawKey: Uint8Array): KvKey {
  const key: KvKeyPart[] = [];
  let offset = 0;

  while (offset < rawKey.length) {
    const tag = rawKey[offset++]!;
    switch (tag) {
      case 0x10:
        if (offset >= rawKey.length) throw new TypeError("Invalid boolean key encoding");
        key.push(rawKey[offset++] === 1);
        break;
      case 0x20: {
        const decoded = decodeNumber(rawKey, offset);
        key.push(decoded.value);
        offset = decoded.offset;
        break;
      }
      case 0x30: {
        const decoded = decodeBigint(rawKey, offset);
        key.push(decoded.value);
        offset = decoded.offset;
        break;
      }
      case 0x40: {
        const decoded = decodeEscapedBytes(rawKey, offset);
        key.push(new TextDecoder().decode(decoded.bytes));
        offset = decoded.offset;
        break;
      }
      case 0x50: {
        const decoded = decodeEscapedBytes(rawKey, offset);
        key.push(decoded.bytes);
        offset = decoded.offset;
        break;
      }
      default:
        throw new TypeError(`Unknown key tag: ${tag}`);
    }
  }

  return key;
}

function decodeEscapedBytes(data: Uint8Array, offset: number): { bytes: Uint8Array; offset: number } {
  const out: number[] = [];
  while (offset < data.length) {
    const byte = data[offset++]!;
    if (byte !== 0) {
      out.push(byte);
      continue;
    }
    if (offset >= data.length) throw new TypeError("Invalid escaped key encoding");
    const next = data[offset++]!;
    if (next === 0xff) {
      out.push(0);
      continue;
    }
    if (next === 0) {
      return { bytes: new Uint8Array(out), offset };
    }
    throw new TypeError("Invalid escaped key encoding");
  }
  throw new TypeError("Unexpected end of key encoding");
}

function decodeNumber(data: Uint8Array, offset: number): { value: number; offset: number } {
  const bytes = data.slice(offset, offset + 8);
  if (bytes.length !== 8) throw new TypeError("Invalid number key encoding");
  const negative = (bytes[0] & 0x80) === 0;
  if (negative) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (~bytes[i]) & 0xff;
  } else {
    bytes[0] ^= 0x80;
  }
  return {
    value: new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, false),
    offset: offset + 8,
  };
}

function decodeBigint(data: Uint8Array, offset: number): { value: bigint; offset: number } {
  if (offset >= data.length) throw new TypeError("Invalid bigint key encoding");
  const sign = data[offset++]!;
  const lenInfo = readU32be(data, offset);
  offset = lenInfo.offset;
  const length = sign === 0x00 ? 0xffffffff - lenInfo.value : lenInfo.value;
  const bytes = data.slice(offset, offset + length);
  if (bytes.length !== length) throw new TypeError("Invalid bigint key payload");

  if (sign === 0x00) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (~bytes[i]) & 0xff;
    return { value: -bytesToBigint(bytes), offset: offset + length };
  }
  return { value: bytesToBigint(bytes), offset: offset + length };
}

function readU32be(data: Uint8Array, offset: number): { value: number; offset: number } {
  if (offset + 4 > data.length) throw new TypeError("Invalid bigint key encoding");
  return {
    value: new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, false),
    offset: offset + 4,
  };
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return BigInt(`0x${hex || "0"}`);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new TypeError("Invalid hex payload");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toUint8Array(value: Uint8Array | ArrayBufferView | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function viewToBytes(value: ArrayBufferView): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function formatKey(key: KvKey): string {
  return JSON.stringify(key, (_name, value) => {
    if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
    if (value instanceof Uint8Array) return { type: "Uint8Array", value: Array.from(value) };
    return value;
  });
}

function fromFileUrl(url: URL): string {
  const pathname = decodeURIComponent(url.pathname);
  if (/^\/[a-zA-Z]:\//.test(pathname)) {
    return pathname.slice(1).replace(/\//g, "\\");
  }
  return pathname;
}