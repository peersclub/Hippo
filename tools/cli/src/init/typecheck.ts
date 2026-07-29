/**
 * Strict standalone typecheck for generated modules — the validation gate of
 * stage-4 mapping synthesis, and the same harness the mapping tests assert
 * with. A generated module is only accepted when this returns ZERO
 * diagnostics; a model-synthesized body that fails here is retried once and
 * then discarded for the deterministic throwing stub.
 *
 * The module is checked in an isolated temp directory so it must be genuinely
 * self-contained: no imports resolve, exactly like the artifact a partner
 * receives before wiring it against `@hippo/seam`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

/** Typecheck a generated module in isolation; returns flattened diagnostic messages. */
export function typecheckModule(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-mapping-'))
  const file = join(dir, 'mapping.ts')
  try {
    writeFileSync(file, source, 'utf8')
    const program = ts.createProgram([file], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    })
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
