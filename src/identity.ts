import { CliError, Exit } from './output.js';

// Organization is encoded by Oracle in the client ID, never independently chosen.
// Decode only to derive addressing; send the original client ID to Oracle unchanged.
export function organizationFromClientId(clientId: string): string {
  const invalid = () => new CliError(Exit.usage, 'Client ID must be Base64 encoding of <organization>.<UUID>; organization cannot be overridden');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clientId) || clientId.length % 4 === 1 || (clientId.includes('=') && clientId.length % 4 !== 0)) throw invalid();
  const bytes = Buffer.from(clientId, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== clientId.replace(/=+$/, '')) throw invalid();
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalid(); }
  const match = /^([^\s\u0000-\u001f\u007f]+)\.[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.exec(decoded);
  if (!match) throw invalid();
  return match[1]!;
}
