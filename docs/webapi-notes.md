# Web API notes

Non-obvious formats and invariants in `cno/src/webapi/`. Code carries only a
one-line pointer back to the relevant section.

## Errors (`basic.ts`)

- QuickJS exposes `stack` only through a CGETSET accessor on `Error.prototype`,
  so no error has an own `stack`. V8 defines an own, lazily computed,
  non-enumerable, configurable accessor on every error; the polyfill installs
  that shape so own-property walks, `inspect(showHidden)` and
  `Object.getOwnPropertyNames(e)` match Node.
- Engine frames are headerless (`at …`). Node's `.stack` starts with
  `Name: message` and has no trailing newline. The polyfill adds the header and
  trims the trailing newline, exactly once per error (V8 caches the first
  formatted value, so a later `err.name = …` must not re-header it).
- A value returned by an `Error.prepareStackTrace` hook is authoritative and is
  handed back verbatim. It is tracked in a `WeakSet` rather than guessed from
  its shape. QuickJS calls the hook from C as `(error, sites)`; `sites` may hold
  the error-proxy trap's own `construct`/`apply` frames, which are stripped
  before the hook sees them.
- Errors raised from C (no JS constructor runs) keep the prototype accessor;
  their stack content is fixed there, but their own-property shape still
  differs from Node until `build_backtrace` in quickjs.c defines an own stack.
- `Error.prepareStackTrace` is stored in the engine slot behind its CGETSET,
  which must keep reporting the user's function, not the wrapper.
- The proxy trap frames look like `at construct (<core>:…)` or
  `at apply (native)`, and their `CallSite`s report function name
  `construct`/`apply` with a null, undefined or `<core>` filename.

## Timers (`basic.ts`)

- `setTimeout`/`setInterval` accept any receiver. Node exports the same
  function objects as globals and from `node:timers`, and fake-timer libraries
  (`sinon`, jest) copy them onto a table and call them as methods. Adding a
  brand check breaks those.
- `refresh()` restarts the countdown; a cleared timer stays cleared.

## Encoding (`basic.ts`)

- WHATWG "get an encoding" maps a label to a canonical name after stripping
  HTTP whitespace only (not `String.prototype.trim`'s Unicode set) and
  ASCII-lowercasing. `text.Decoder` is iconv-backed and reports raw labels, so
  the label table is kept here. `replacement` resolves but the `TextDecoder`
  constructor rejects it.
- `TextDecoder` accepts SharedArrayBuffer-backed views (`[AllowShared]`);
  a non-buffer input is a TypeError, a detached buffer decodes to `''`.

## URLs (`url.ts`)

- Parse order is spec order: strip leading/trailing C0-controls-and-space, then
  remove every tab/LF/CR from the input. `trim()` gets both directions wrong.
- A non-special scheme has an opaque path only when the scheme is spelled out
  in the input and is not followed by `/`. `<scheme>:/a/b` builds a list path
  (so `pack:/…` is a valid base); an inherited scheme is a relative reference.
- Relative references against an opaque base (`data:…`): only a fragment-only
  reference is valid, so `''`, `?q`, `./x` all throw.
- Path shortening applies to every scheme, including non-special `pack:/…`;
  only opaque paths keep `..` literally. Shortening stops at a `file:` drive
  letter, so `..` cannot escape it. A final dot segment pushes an empty segment,
  which carries the trailing slash. The empty segment is otherwise ordinary and
  must be preserved (`//key` names a different resource than `/key`).
- Percent-decoding substitutes U+FFFD for malformed UTF-8; decoding per byte
  would yield Latin-1 and `engine.decodeString` would leak WTF-8 surrogates.
- Parse failures are `TypeError` with `code: 'ERR_INVALID_URL'` and `.input`.

## Streams (`basic.ts`)

- `engine.encodeString` emits WTF-8 for unpaired surrogates; `TextEncoder`
  substitutes U+FFFD via `utils/bytes.sanitizeSurrogates` first.
- `structuredClone`'s second argument is always an options dictionary here;
  a bare array is re-wrapped as `{ transfer }` so it never selects the helper's
  internal transfer-list overload.

## `cno/src/deno/index.ts`

- `lifecycleMux` is loaded dynamically and tolerantly (same reason as
  `webapi/index.ts`): `cno/src/deno` has no build-time dependency on cts, and a
  standalone cno without cts still runs its test harness without
  `load`/`unload`. The dispatchers are idempotent, so `run.ts` cannot
  double-fire them; the `unload` dispatch is mandatory, because a `load`
  listener that arms `setInterval` would otherwise hang the process.
- The `04_stdio` import stays staged (not in the `Promise.all`): its
  `stdin`/`stdout`/`stderr` export is a requested field of this module, which
  re-issues the graph into an awaiting cycle. All other polyfills only
  `Reflect.set`/`Object.assign` distinct members, so they are requested once and
  evaluate concurrently.
- Feature modules are lazy because embedded bytecode is decoded as one module:
  anything reachable from boot costs startup. `defineLazy` keeps the public shape
  and evaluates on first read, replacing the accessor with the data property.

## `Intl` (`intl.ts`)

- **Time zones.** No IANA tz database is available, so only zones with a
  constant offset can be honoured: `UTC` and aliases,
  `Etc/GMT{+0..+12,-0..-14}` (POSIX sign inversion), and offset literals
  `+HH:MM`, `+HHMM`, `+HH`. Named IANA zones throw `RangeError` instead of
  formatting in the host zone. Offset literals report back in literal form
  (`+00:00`), never as `UTC`, because node does.
- **Host zone.** The host's IANA name is not knowable, so the reported zone name
  is the host's current offset. `TZ` is preferred only when it names a zone we
  can honour.
- **Number rounding.** Rounding runs on the value's shortest round-trip decimal
  string, not `toFixed()` (`(1.005).toFixed(2)` is `"1.00"` but ICU prints
  `"1.01"` for `maximumFractionDigits: 2`).
- **`timeZoneName` output** (node):

  | offset | `short` | `long` | `shortOffset` | `longOffset` |
  | --- | --- | --- | --- | --- |
  | 0 | `UTC` | `Coordinated Universal Time` | `GMT+0` | `GMT+00:00` |
  | -300 | `GMT-5` | `GMT-05:00` | `GMT-5` | `GMT-05:00` |
  | +330 | `GMT+5:30` | `GMT+05:30` | `GMT+5:30` | `GMT+05:30` |

- **`toLocale*` options defaults.** `dateStyle`/`timeStyle` expand to node's
  skeletons; with neither style nor any component, node defaults to numeric
  year/month/day. ECMA-402 defaults are filled only when the caller asked for
  nothing in that group: `toLocaleString('en-US', {year: 'numeric'})` is `"2021"`,
  while `toLocaleDateString('en-US', {hour: 'numeric'})` is `"3/4/2021, 3 PM"`.
- **Plain calls.** ECMA-402 allows `DateTimeFormat`, `NumberFormat` and
  `Collator` to be called without `new`; the other constructors must throw
  `TypeError`. The wrapper shares the class prototype so `instanceof` and statics
  keep working.
- **Prototype re-points.** quickjs implements `Date.prototype.toLocale*String`
  (C `get_date_string`, magic `0x31`/`0x32`/`0x33`) and
  `Number.prototype.toLocaleString` (`js_number_toString`) without consulting
  `Intl`, so `date.toLocaleString('en-US', {timeZone: 'UTC'})` ignored both
  arguments. All four descriptors are writable and configurable in the shipped
  binary, so this layer re-points them.
- `String.prototype.localeCompare` is deliberately not re-pointed: its live
  callers are `cts/src/utils/misc.ts:291`, `src/commands/repl/completion.ts:83`
  and `tests/deno/fs-upstream-compat.test.ts`, and root collation reorders
  results relative to the current code-point compare.

## Fetch helpers (`fetch/helpers.ts`)

- `teeUntracked` exists because `tee()` goes through the public `getReader`:
  `clone()` must temporarily bypass body-stream tracking, patch the stream to
  keep its private fields, then track each branch separately. The original
  descriptor is restored even when `tee()` throws on a locked stream.

## Listener hooks (`events.ts`)

`node:events` keeps listener bookkeeping for native EventTargets and reads its
hooks from globals, since neither module may import the other; either may
evaluate first, so `node:events` publishes an installer on a global and this
module calls it once defined. Polyfill EventTargets are marked with
`Symbol.for('cno.internal.webEventTarget')` so the hooks recognise and skip them
in O(1); the class reports listener changes through `notifyListenerChange`.

## CompressionStream (`streams.ts`)

`progressed` tracks whether the decompressor handle ever moved an input byte.
zlib only reports Z_DATA_ERROR for a damaged member once it has progressed; a
header rejected outright (garbage in one chunk) makes `inflate()`/`finish()`
throw an uncatchable InternalError that kills the process, so that case is
refused before the call.
