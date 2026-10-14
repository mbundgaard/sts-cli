import { createHash, randomBytes } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { request, type HttpResponse } from './transport.js';
import { CliError, Exit } from './output.js';
import { baseUrl, type AuthConfig, type TokenSet } from './state.js';

const redirectUri = 'apiaccount://callback';
const scope = 'openid';
type Stage = 'authorize' | 'signin' | 'token' | 'refresh';
export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
function parse(response: HttpResponse): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(response.body.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Do not expose JSON parser excerpts of credential-bearing responses. */ }
  throw new CliError(Exit.auth, 'IDM returned an invalid JSON object');
}
// Only documented machine classifications are exposed. No arbitrary response text,
// authorization codes, redirect URLs, reset tokens, usernames or cookies are logged.
const safeErrors = new Set(['VALIDATION_ERRORS', 'AUTHENTICATION_INVALID', 'RECORD_NOT_FOUND', 'INVALID_CLIENT', 'invalid_client', 'invalid_grant', 'invalid_request']);
export class AuthClient {
  readonly cookies = new CookieJar();
  constructor(private readonly timeoutMs = 30_000, private readonly quiet = false) {}
  private async send(stage: Stage, url: string, form?: Record<string, string>): Promise<HttpResponse> {
    let cookie: string;
    try { cookie = await this.cookies.getCookieString(url); }
    catch { throw new CliError(Exit.auth, 'IDM cookie jar failed; cookie contents withheld'); }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let response: HttpResponse;
    try {
      response = await request({ url, method: form ? 'POST' : 'GET', headers,
        body: form ? new URLSearchParams(form).toString() : undefined, timeoutMs: this.timeoutMs });
    } catch {
      throw new CliError(Exit.network, `IDM ${stage} request failed; outcome may be uncertain`, 'No retry was made. Check connectivity/TLS and saved state before repeating authentication.');
    }
    try {
      for (const value of response.headers['set-cookie'] ?? []) await this.cookies.setCookie(value, url);
    } catch { throw new CliError(Exit.auth, 'IDM returned an invalid cookie; cookie contents withheld'); }
    if (!this.quiet) process.stderr.write(`[auth ${stage}] HTTP ${response.status}\n`);
    const success = response.status >= 200 && response.status < 300;
    const authorizeRedirect = stage === 'authorize' && [302, 303].includes(response.status);
    if (!success && !authorizeRedirect) {
      let code: string | undefined;
      try { const body = parse(response); if (typeof body.code === 'string' && safeErrors.has(body.code)) code = body.code; } catch { /* Error body stays private. */ }
      throw new CliError(Exit.auth, `IDM ${stage} rejected request (HTTP ${response.status})${code ? `: ${code}` : ''}`,
        'Verify the configured IDM URL, account, organization and client ID. HTTP failure alone does not prove password expiry. No retry was made.');
    }
    return response;
  }
  private tokens(response: HttpResponse, verifier: string, priorRefresh?: string): TokenSet {
    const value = parse(response);
    if (typeof value.access_token !== 'string' || !value.access_token.trim() || /[\u0000-\u001f\u007f]/.test(value.access_token)) throw new CliError(Exit.auth, 'IDM response did not contain a valid STS access_token; id_token is not a substitute');
    const refreshToken = typeof value.refresh_token === 'string' && value.refresh_token ? value.refresh_token : priorRefresh;
    if (!refreshToken || !refreshToken.trim() || /[\u0000-\u001f\u007f]/.test(refreshToken)) throw new CliError(Exit.auth, 'IDM response did not contain a valid refresh_token');
    const seconds = typeof value.expires_in === 'string' && /^\d+$/.test(value.expires_in) ? Number(value.expires_in) : value.expires_in;
    const knownLifetime = typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0 && Number.isFinite(new Date(Date.now() + seconds * 1000).getTime());
    // Preserve rotated credentials even when optional expiry metadata is unusable.
    if (!knownLifetime && !this.quiet) process.stderr.write('[auth] Token expiry is unknown; credentials will be saved without guessing a lifetime.\n');
    return { accessToken: value.access_token, refreshToken, codeVerifier: verifier, obtainedAt: new Date().toISOString(), expiresIn: knownLifetime ? seconds as number : undefined };
  }
  async login(auth: AuthConfig, password: string): Promise<TokenSet> {
    if (!password) throw new CliError(Exit.usage, 'Supply --password (used for login only)');
    requireAuth(auth, true);
    const { verifier, challenge } = pkce();
    const base = baseUrl(auth.authUrl!) + '/oidc-provider/v1/oauth2';
    const query = new URLSearchParams({ client_id: auth.clientId!, code_challenge: challenge,
      code_challenge_method: 'S256', redirect_uri: redirectUri, response_type: 'code', scope });
    await this.send('authorize', `${base}/authorize?${query}`);
    // Use Oracle's cookie jar verbatim. Do not overwrite or re-encode its OAuth
    // cookies (in particular raw client-ID padding), and never follow redirects.
    const signedIn = parse(await this.send('signin', `${base}/signin`, {
      username: auth.username!, password, orgname: auth.orgName!,
    }));
    if (signedIn.nextOp !== 'redirect' || signedIn.success === false || typeof signedIn.redirectUrl !== 'string') {
      throw new CliError(Exit.auth, signedIn.nextOp === 'expired'
        ? 'Oracle explicitly reports password expiry; reset it through Oracle before another login'
        : 'Oracle sign-in did not return an authorization redirect');
    }
    let code: string | null;
    try {
      const redirect = new URL(signedIn.redirectUrl);
      if (redirect.protocol !== 'apiaccount:' || redirect.hostname !== 'callback' || redirect.port || redirect.username || redirect.password || signedIn.redirectUrl.includes('#') || !['', '/'].includes(redirect.pathname) || redirect.searchParams.getAll('code').length !== 1) throw new Error();
      code = redirect.searchParams.get('code');
    } catch { throw new CliError(Exit.auth, 'Oracle returned an invalid authorization callback; URL withheld'); }
    if (!code?.trim()) throw new CliError(Exit.auth, 'Oracle redirect contained no authorization code');
    return this.tokens(await this.send('token', `${base}/token`, {
      client_id: auth.clientId!, code_verifier: verifier, redirect_uri: redirectUri,
      scope, grant_type: 'authorization_code', code,
    }), verifier);
  }
  async refresh(auth: AuthConfig, old?: TokenSet): Promise<TokenSet> {
    requireAuth(auth, false);
    if (!old?.refreshToken || !old.codeVerifier) throw new CliError(Exit.noTokens, 'No STS refresh token/PKCE verifier saved; run sts auth login');
    return this.tokens(await this.send('refresh', baseUrl(auth.authUrl!) + '/oidc-provider/v1/oauth2/token', {
      client_id: auth.clientId!, code_verifier: old.codeVerifier, redirect_uri: redirectUri,
      scope, grant_type: 'refresh_token', refresh_token: old.refreshToken,
    }), old.codeVerifier, old.refreshToken);
  }
}
function requireAuth(auth: AuthConfig, login: boolean) {
  const keys: (keyof AuthConfig)[] = login ? ['authUrl', 'clientId', 'orgName', 'username'] : ['authUrl', 'clientId'];
  const missing = keys.filter(key => typeof auth[key] !== 'string' || !auth[key]!.trim() || /[\u0000-\u001f\u007f]/.test(auth[key]!));
  if (missing.length) throw new CliError(Exit.notConfigured, `Missing or invalid auth configuration: ${missing.join(', ')}`, 'Run sts auth config --help');
}
