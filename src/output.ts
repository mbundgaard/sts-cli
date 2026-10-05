export const Exit = {
  ok: 0, usage: 6, notConfigured: 7, noTokens: 8,
  auth: 9, network: 10, api: 11, state: 12,
} as const;

export class CliError extends Error {
  constructor(public readonly exitCode: number, message: string, public readonly hint?: string) {
    super(message);
  }
}

// Local commands have a stable envelope. STS response bodies bypass this entirely.
export function localResult(command: string, data: unknown): void {
  process.stdout.write(JSON.stringify({ ok: true, command, data }, null, 2) + '\n');
}
export function reportError(error: unknown): number {
  const known = error instanceof CliError;
  const exitCode = known ? error.exitCode : 1;
  process.stderr.write(JSON.stringify({ ok: false, error: {
    code: exitCode, message: error instanceof Error ? error.message : String(error),
    ...(known && error.hint ? { hint: error.hint } : {}),
  } }) + '\n');
  return exitCode;
}
