# Node Internals

Implementation notes for the Node compatibility layer under `cno/src/node/` whose
details are too specific to survive as long inline comments.

## structured-clone-tagged-dispatch

`cno/src/node/_internal/structured-clone.ts` uses `Object.prototype.toString` as a
fast discriminant instead of probing accessors and catching `TypeError`.

- The tag is trusted only when `Symbol.toStringTag` is absent from the whole
  prototype chain (`tagPropertyState`), checked without invoking getters or Proxy
  traps. Tagged chains, and any Proxy, fall back to the throwing probes.
- The tag answers exactly one question: "is this a boxed Number/String/Boolean?".
  `[object Object]` is taken as proof that it is not. The only types that can
  falsify that proof are BigInt and Symbol objects, which are named by
  `@@toStringTag` rather than by a slot; deleting the property makes a real one
  report `[object Object]`, and it would then be cloned as a plain object (losing
  the BigInt value) or cloned at all (where a Symbol object must throw).
- The soundness check (`tagDispatchIsSound`) must therefore run per call. A
  load-time check misses a later `delete BigInt.prototype[Symbol.toStringTag]`.
- The tag must never rule out types named by `@@toStringTag`: Map, Set,
  ArrayBuffer, SharedArrayBuffer, DataView, TypedArray, Promise and Weak*. They are
  settled by non-throwing native predicates (`engine.isMap`, `ArrayBuffer.isView`,
  ...) that run unconditionally. A foreign-realm Map inherits its own realm's
  `@@toStringTag` and routes to `engine.isMap`.
- Map/Set/Error are tested before the boxed-primitive probe. An object holds at
  most one of `[[MapData]]`/`[[SetData]]`/`[[ErrorData]]`/`[[NumberData]]`/
  `[[StringData]]`/`[[BooleanData]]`, so order cannot change an outcome; testing
  them first only spares them the five-throw probe.
- The SharedArrayBuffer probe is the remaining throw on the slow path and cannot be
  tag-gated, so it runs as late as possible.

## non-serializable-platform-objects

Platform objects with internal slots and no serialization steps throw
`DataCloneError`. The list is URL, URLSearchParams, Headers, FormData, Request,
Response, ReadableStream, WritableStream and TransformStream; AbortSignal,
EventTarget, TextEncoder/Decoder, Performance and BroadcastChannel are excluded
because both Node and Deno clone those to plain objects.

In cno, Request, Response, ReadableStream, WritableStream and TransformStream carry
no `@@toStringTag` and report `[object Object]` (Node tags all five), so the check
cannot be gated on the tag. It is gated on prototype identity instead: an object
whose immediate prototype is `Object.prototype`, `Array.prototype` or `null` cannot
be an instance of any of the nine. Anything else runs the full `instanceof` loop,
so subclasses, cross-realm instances and exotic prototypes are still checked.
Not covered: a constructor with a custom `Symbol.hasInstance` that claims plain
objects.

## dataview-pipe-tag

A DataView is an ArrayBufferView, but the native pipe serializer (used for worker
messages) rejects it with "unsupported object class", while typed arrays and bare
ArrayBuffers cross intact. It is therefore encoded as
`{ __cno_structured_clone_dataview__: true, buffer, byteOffset, byteLength }` and
rebuilt on arrival. Decoding goes through `decodeFromPipe` so that two views over
one buffer decode to two views over one shared buffer.

The throw this prevents is not cosmetic: when the receiving worker is not ready,
the payload is queued and the failure surfaces later from `_flushOutgoingQueue` as
an unhandled rejection that no `try/catch` around `postMessage` can reach, and the
event loop wedges.

## fs-walk-gates

`cno/src/node/fs/utils.ts` uses two descent policies for a recursive directory
walk because Node's behave differently:

- `'follow'` descends when the entry resolves to a directory, so Windows reparse
  points are walked. Used by readdirSync, callback readdir and readdir without
  withFileTypes.
- `'strict'` descends only for dirent-typed directories. Used by readdir with
  withFileTypes and every opendir form.

On Windows a junction and a directory symlink are both `UV_DIRENT_LINK` (libuv
tests the reparse flag before the directory flag), so the dirent cannot tell them
apart; the follow gate must stat. A resolve failure means "not a directory",
never an abort: broken links are listed without descending, and junction cycles
end when Windows refuses a reparse traversal (ELOOP after 64 junctions,
independent of path length).

recursive readdir is breadth-first: every entry of a level is emitted before any
entry of the next one, so a depth-first walk would reorder the results.

## fs-open-flags

`VALID_OPEN_FLAGS` lists every flag string Node accepts. The native layer matches
flag *characters* rather than whole strings, so an unvalidated `'rw'` would open
the file O_TRUNC and destroy it, where Node throws `ERR_INVALID_ARG_VALUE`.
Numeric flags are `O_*` bitmasks and pass through untouched.

## crypto-rsa-padding

The native sign/verify entry points (`crypto.signSha256` and friends) take no
padding argument and always use PKCS#1 v1.5. A PSS request used to be served
PKCS#1 v1.5 silently, and the resulting signature verified against an explicit
PSS request. Until the native layer accepts a padding parameter,
`rejectUnsupportedPadding` throws `ERR_CRYPTO_INVALID_PADDING` for anything but
`RSA_PKCS1_PADDING` (1).

## crypto-p1363-key-inspection

The ieee-p1363 ECDSA encoding is two fixed-width coordinates, so both conversion
directions need the key's curve. Raw scalars and raw uncompressed points
announce size by length; a PEM or DER key does not. Letting `verify()` infer the
size from the signature length instead makes a valid signature verify when
zero-extended to any even length (signature malleability), and makes a malformed
length throw where Node returns false.

So the namedCurve OID is read out of the key structure. The walk is structural:
only constructed nodes are descended and re-parsed, so primitive payloads
(INTEGER, BIT STRING, OCTET STRING, i.e. key material) can never be mistaken for
an OID. Layouts:

```
SPKI    SEQUENCE { SEQUENCE { OID alg, OID curve }, BIT STRING }
PKCS8   SEQUENCE { INTEGER, SEQUENCE { OID alg, OID curve }, OCTET STRING }
SEC1    SEQUENCE { INTEGER, OCTET STRING, [0] { OID curve }, [1] { ... } }
```

Curve OIDs are checked before the non-EC algorithm OIDs because an EC key carries
both. PKCS#1 has no OID (a bare SEQUENCE of INTEGERs), so the PEM label is the
only signal. Node ignores dsaEncoding for non-EC keys. `classifyKeyForP1363`
returns `'unknown'` (distinct from `'non-ec'`) for shapes it does not recognise,
so callers keep the previous behaviour for them.

DER lengths are accumulated with multiplication: `(length << 8) | byte` wraps
negative for a 4-byte length with the top bit set, and a negative length silently
defeats every `end > bytes.length` bounds check.

## crypto-asymmetric-key-details

`keyDetailsFromBytes` derives `asymmetricKeyDetails` for keys parsed from PEM/DER.
Node's shapes:

```
EC       { namedCurve: 'prime256v1' | 'secp384r1' | 'secp521r1' }
RSA      { modulusLength: <bits>, publicExponent: <BigInt> }
ed/x     {}          (present but empty)
secret   undefined
```

Structure is checked before the raw-length heuristic: an Ed25519 PKCS#8 is 48
bytes, the same as a P-384 coordinate. RSA modulus length counts the bits after
stripping DER's sign-padding zero.

## http-aborted

`IncomingMessage.destroy()` emits `'aborted'` only when the message is incomplete
and not already aborted. The client truncation path
(`http-client.ts::failResponse`) announces the abort and then calls
`destroy(err)`; emitting unconditionally produced
`aborted -> aborted -> error -> close`.

## http-core-limits

The core server alone enforces `maxHeaderSize`, `maxHeadersCount` and
`maxConnections`, so `ServerImpl` must forward them (header size in
`http/src/h1.ts`, connection count in `http/src/server.ts`); otherwise the core
uses its defaults and an oversized request head still gets 200 OK instead of 431.
`maxHeadersCount` is forwarded only when explicitly set, because Node does
not enforce it itself. `maxConnections` corresponds to what net.Server applies on
its own accept path.

## TLS (`tls/`)

- `requestCert` maps to the C layer's `SSL_VERIFY_PEER|SSL_VERIFY_FAIL_IF_NO_PEER_CERT`,
  so it is passed only for servers; `verifyHostname` is stood down when the
  caller supplies `checkServerIdentity`, because OpenSSL would fail the
  handshake in C before JS could run the callback. A custom callback always
  runs on a client handshake.
- Both read pumps run outside JS control flow, so faults convert to `'error'`
  (and `destroy()`) rather than escaping. A peer teardown during `pipe.read()`
  is EOF: it is only emitted as `'error'` when a listener exists, otherwise the
  readable side is closed.
- `subjectaltname` is a comma-separated list of typed entries (`DNS:h`,
  `IP Address:1.2.3.4`); emitting bare names makes `checkServerIdentity` fall
  back to the CN.

## CA trust state (`tls/_shared.ts`)

- The system-store cache, the override set and the override flag are one unit
  that lives only in `_shared.ts`; duplicating any of them breaks
  `setDefaultCACertificates()`. Probing is synchronous (SecureContext
  construction is) and runs once: Windows reads the OS ROOT/CA stores, other
  platforms read the conventional OpenSSL bundle paths. `rootCertificates`
  reports the platform store, one PEM per certificate.

## Assert messages (`assert/mod.ts`)

- Comparison assertions throw the caller's Error instance as-is; the
  throws/rejects family renders an Error message as `Name: message`.
- Negated assertions inline a short value (5 chars inlines, 6 blocks) for the
  strict forms; loose `notDeepEqual` always blocks with no trailing newline.
- `__proto__: null` on descriptor literals is required: `defineProperty`
  resolves fields through `HasProperty`, so a polluted `Object.prototype.get`
  would otherwise make `value` + accessor both specified.
