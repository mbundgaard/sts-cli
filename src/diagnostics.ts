import type { BuiltRequest } from './requests.js';

// Match Node's certificate-validation error codes, not message substrings. A
// refused socket, timeout, DNS failure or generic TLS protocol failure is not
// evidence that disabling certificate verification would help.
const certificateErrors = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_REVOKED', 'CERT_UNTRUSTED',
  'CERT_REJECTED', 'CERT_SIGNATURE_FAILURE',
]);

export function networkFailureHint(error: unknown, request: BuiltRequest): string | undefined {
  const hints: string[] = [];
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && certificateErrors.has(code)) {
    hints.push('TLS certificate validation failed. Check the hostname and fix the server certificate or trusted CA configuration first.');
    if (request.insecureAllowed && !request.insecure) {
      hints.push('For a trusted STS endpoint only, --insecure can disable certificate verification for one call. '
        + 'Ask the user for explicit confirmation for this endpoint before adding --insecure or retrying. '
        + 'It disables server identity verification and can expose the Bearer token and request data. Never retry automatically.');
    }
  }
  if (request.method === 'POST' || request.method === 'DELETE') {
    hints.push('Outcome may be uncertain. Do not blindly retry a write; reconcile or reuse its explicit idempotency ID.');
  }
  return hints.length ? hints.join(' ') : undefined;
}
