import { createHash, randomBytes } from 'node:crypto';
import { CookieJar, Cookie } from 'tough-cookie';
import { request, type HttpResponse } from './transport.js';
import { CliError, Exit } from './output.js';
import { type AuthConfig, type TokenSet } from './state.js';

const redirectUri = 'apiaccount://callback';
const scope = 'openid';
export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}
export class AuthClient {
  readonly cookies = new CookieJar();
  constructor(private readonly timeoutMs = 30_000, private readonly quiet = false) {}
  async send(url: string, form?: Record<string, string>): Promise<HttpResponse> {
    const cookie = await this.cookies.getCookieString(url);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    let response: HttpResponse;
    try { response = await request({ url, method: form ? 'POST' : 'GET', headers,
      body: form ? new URLSearchParams(form).toString() : undefined, timeoutMs: this.timeoutMs }); }
    catch (e) { throw new CliError(Exit.network, `IDM request failed: ${(e as Error).message}`); }
    for (const cookie of response.headers['set-cookie'] ?? []) await this.cookies.setCookie(cookie, url);
    if (!this.quiet) process.stderr.write(`[auth] HTTP ${response.status}\n`);
    if (response.status < 200 || response.status >= 400) {
      throw new CliError(Exit.auth, `IDM rejected request (HTTP ${response.status})`, 'Check your environment and credentials; an expired password requires changing it through Oracle.');
    }
    return response;
  }
  parse(response: HttpResponse): Record<string, unknown> {
    try {
      const value: unknown = JSON.parse(response.body.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new CliError(Exit.auth, 'IDM returned an invalid JSON object'); }
  }
  tokens(response: HttpResponse, verifier: string, priorRefresh?: string): TokenSet {
    const value = this.parse(response);
    if (typeof value.access_token !== 'string' || !value.access_token) throw new CliError(Exit.auth, 'IDM response did not contain an access token');
    return {
      accessToken: value.access_token,
      refreshToken: typeof value.refresh_token === 'string' && value.refresh_token ? value.refresh_token : priorRefresh,
      codeVerifier: verifier, obtainedAt: new Date().toISOString(),
      expiresIn: typeof value.expires_in === 'number' ? value.expires_in : undefined,
    };
  }
  async login(auth: AuthConfig, password: string): Promise<TokenSet> {
    if (!password) throw new CliError(Exit.usage, 'Supply --password');
    requireAuth(auth, true);
    const { verifier, challenge } = pkce();
    const base = auth.authUrl!.replace(/\/$/, '') + '/oidc-provider/v1/oauth2';
    const query = new URLSearchParams({ client_id: auth.clientId!, code_challenge: challenge,
      code_challenge_method: 'S256', redirect_uri: redirectUri, response_type: 'code', scope });
    await this.send(`${base}/authorize?${query}`);
    // Oracle supplies OAuth cookies during authorize. Preserve their exact values:
    // rewriting a padded client ID as %3D%3D can make signin reject the client.
    const supplied = new Set((await this.cookies.getCookies(`${base}/signin`)).map(cookie => cookie.key));
    for (const [key, value] of Object.entries({ client_id: auth.clientId!, code_challenge: challenge,
      code_challenge_method: 'S256', redirect_uri: redirectUri, response_type: 'code' })) {
      if (!supplied.has(key)) await this.cookies.setCookie(new Cookie({ key, value: encodeURIComponent(value), path: '/' }), auth.authUrl!);
    }
    const signedIn = this.parse(await this.send(`${base}/signin`, {
      username: auth.username!, password, orgname: auth.orgName!,
    }));
    if (signedIn.nextOp !== 'redirect' || typeof signedIn.redirectUrl !== 'string') {
      throw new CliError(Exit.auth, signedIn.nextOp === 'expired'
        ? 'Oracle password has expired; change it before logging in' : 'Oracle sign-in did not return an authorization redirect');
    }
    let code: string | null;
    try { code = new URL(signedIn.redirectUrl).searchParams.get('code'); }
    catch { throw new CliError(Exit.auth, 'Oracle returned an invalid authorization redirect'); }
    if (!code) throw new CliError(Exit.auth, 'Oracle redirect contained no authorization code');
    return this.tokens(await this.send(`${base}/token`, {
      client_id: auth.clientId!, code_verifier: verifier, redirect_uri: redirectUri,
      scope, grant_type: 'authorization_code', code,
    }), verifier);
  }
  async refresh(auth: AuthConfig, old?: TokenSet): Promise<TokenSet> {
    requireAuth(auth);
    if (!old?.refreshToken || !old.codeVerifier) throw new CliError(Exit.noTokens, 'No refresh token / PKCE verifier saved; run sts auth login');
    const url = auth.authUrl!.replace(/\/$/, '') + '/oidc-provider/v1/oauth2/token';
    return this.tokens(await this.send(url, { client_id: auth.clientId!, code_verifier: old.codeVerifier,
      redirect_uri: redirectUri, scope, grant_type: 'refresh_token', refresh_token: old.refreshToken,
    }), old.codeVerifier, old.refreshToken);
  }
}
function requireAuth(auth: AuthConfig, login = false) {
  const keys: (keyof AuthConfig)[] = login ? ['authUrl', 'clientId', 'orgName', 'username'] : ['authUrl','clientId'];
  const missing = keys.filter(key => !auth[key]);
  if (missing.length) throw new CliError(Exit.notConfigured, `Missing auth configuration: ${missing.join(', ')}`, 'Run sts auth config --help');
}
