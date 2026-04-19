# lang/

MTP source language compiler. Transforms `.mtp` source files into the JSON
plugin schema consumed by device runtimes.

## Pipeline

```
source text
    \/
 lexer.ts        tokenize -> Token[]
    \/
 parser.ts       Token[] -> PluginNode (AST)
    \/
 linker.ts       AST + descriptors -> symbol table, diagnostics, permission analysis
    \/
 emitter/        AST -> MtpPlugin (JSON schema)
```

Each stage collects its own `LangDiagnostic[]`. The orchestrator in `index.ts`
merges them. Errors are always returned as diagnostics, exceptions are not expected.

## Stages

**Lexer** (`lexer.ts`, `token.ts`) -- Stateless tokenizer. Produces a flat
token stream including whitespace-significant indentation tokens.

**Parser** (`parser.ts`, `ast.ts`) -- Recursive descent. Builds a `PluginNode`
containing metadata, config/globals blocks, function definitions (`fn`/`def`),
and event handlers (`on`). See `ast.ts` for the full node type hierarchy.

**Linker** (`linker.ts`, `symbol-table.ts`) -- Semantic validation pass.
Builds a `SymbolTable` from the AST, optionally enriched with API descriptors
from `@maustec/mt-runtimes`. Validates scope resolution, function call arity,
event names, and tracks permission requirements. Without a `LinkerContext`,
runs in degraded mode (plugin-scoped symbols only, no host function validation).

**Emitter** (`emitter/`) -- Walks the AST to produce the `MtpPlugin` JSON
structure. Split into sub-modules by concern: `plugin.ts` (top-level structure
and metadata), `functions.ts` (def -> action list), `statements.ts`,
`expressions.ts`, `conditions.ts`. Uses `BlockEmitContext` to track local vs
host function calls.

## Entry points

| Function | Use case |
|---|---|
| `transpile(source, context?)` | Full pipeline, one call. CLI `build` command. |
| `parseSource(source)` | Lex + parse only. LSP uses this for incremental re-parse. |
| `link(ast, context?)` | Linker pass on an already-parsed AST. LSP diagnostics. |
| `emitPlugin(ast)` | Emit pass on an already-parsed AST. |

## Diagnostics

All diagnostics use `LangDiagnostic` from `diagnostics.ts` -- a level
(`"error"` | `"warning"`) plus an optional `Span` (1-based line/col range).
The LSP converts these to LSP `Diagnostic` objects; the CLI prints them
directly.

## Key types

- `PluginNode` -- root AST node (ast.ts)
- `SymbolTable` -- function/variable/event resolution (symbol-table.ts)
- `LinkerContext` -- external API descriptors passed into the linker (linker.ts)
- `MtpPlugin` -- output JSON schema (core/mtp-types.ts)
