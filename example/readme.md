# CNO Examples

This directory contains small programs used to exercise the `cno` runtime
polyfill layer. Most examples are written as Deno-style TypeScript and should
also be useful when checking compatibility against Deno, except examples that
intentionally use CNO-specific APIs.

Run an example from the repository root with the staged binary:

```sh
build/stage/cno run cno/example/<name>/index.ts
```

Some examples use a different entry file; see the table below.

## Examples

| Directory | Entry | Purpose |
| --- | --- | --- |
| `homepage/` | `index.ts` | Small web app/static page example |
| `snake/` | `index.ts` | Terminal I/O example using keyboard input |
| `cnoterm/` | `index.ts` | CNO-specific pty-backed terminal-in-browser example |
| `ssr2clash/` | `index.ts` or `main.ts` | Script-style URL/config conversion example |
| `netease/` | `index.ts` or `main.ts` | Larger TypeScript example with shared local modules |

## Notes

- `cnoterm` depends on CNO-specific pty functionality and is not expected to be
  portable to Deno unchanged.
- The examples are not the canonical compatibility matrix. Use `tests/` for
  behavioral checks.
- `deno.json` in this directory is for example-local config and imports.
