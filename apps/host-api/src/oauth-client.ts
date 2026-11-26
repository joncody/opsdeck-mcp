import { z } from "zod";

const ProtectedResourceMetadataSchema = z.object({
  resource: z.string().min(1),
  authorization_servers: z.array(z.string().min(1)).min(1),
  scopes_supported: z.array(z.string()).optional(),
});

const AuthServerMetadataSchema = z.object({
  issuer: z.string().min(1),
  token_endpoint: z.string().min(1),
  client_id_metadata_document_supported: z.boolean().optional(),
});

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
});

type OAuthClientConfig = {
  readonly clientId: string;
  readonly scopes: string;
  readonly subject?: string;
};

type CachedToken = {
  readonly accessToken: string;
  readonly expiresAtMs: number;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type OAuthTokenManager = {
  readonly getToken: (forceRefresh?: boolean) => Promise<string | undefined>;
  readonly invalidate: () => void;
};

const EXPIRY_SKEW_MS = 30_000;
const DEFAULT_TTL_SECS = 600;

function extractMetadataUrlFromWwwAuth(headerValue: string | undefined): string | undefined {
  if (headerValue === undefined) {
    return undefined;
  }
  const match = /resource_metadata="([^"]+)"/.exec(headerValue);
  return match?.[1];
}

function buildWellKnownResourceMetadataUrls(mcpEndpointUrl: string): readonly string[] {
  const url = new URL(mcpEndpointUrl);
  const pathSuffix = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  const candidates: string[] = [];
  if (pathSuffix.length > 0) {
    candidates.push(`${url.origin}/.well-known/oauth-protected-resource${pathSuffix}`);
  }
  candidates.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return candidates;
}

function createOAuthTokenManager(params: {
  readonly mcpEndpointUrl: string;
  readonly config: OAuthClientConfig;
  readonly fetchImpl?: FetchLike;
}): OAuthTokenManager {
  const runFetch = params.fetchImpl ?? fetch;
  let cached: CachedToken | undefined;

  async function discoverMetadata(): Promise<{
    readonly resource: string;
    readonly tokenEndpoint: string;
  } | undefined> {
    const candidates = [...buildWellKnownResourceMetadataUrls(params.mcpEndpointUrl)];

    // Probe RFC 9728 metadata directly, or fall back to WWW-Authenticate challenge on /mcp
    for (const candidateUrl of candidates) {
      const resp = await runFetch(candidateUrl, {
        headers: { accept: "application/json" },
      });
      if (resp.ok) {
        const prm = ProtectedResourceMetadataSchema.parse(await resp.json());
        const issuer = prm.authorization_servers[0];
        if (issuer === undefined) {
          return undefined;
        }
        const asResp = await runFetch(
          `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
          { headers: { accept: "application/json" } },
        );
        if (asResp.ok === false) {
          throw new Error(`OAuth AS metadata fetch failed (${asResp.status})`);
        }
        const asMeta = AuthServerMetadataSchema.parse(await asResp.json());
        return {
          resource: prm.resource,
          tokenEndpoint: asMeta.token_endpoint,
        };
      }
    }

    const challengeResp = await runFetch(params.mcpEndpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/discover" }),
    });
    if (challengeResp.status !== 401) {
      return undefined;
    }

    const wwwAuth = challengeResp.headers.get("www-authenticate") ?? undefined;
    const discoveredPrmUrl = extractMetadataUrlFromWwwAuth(wwwAuth);
    if (discoveredPrmUrl === undefined) {
      return undefined;
    }

    const prmResp = await runFetch(discoveredPrmUrl, {
      headers: { accept: "application/json" },
    });
    if (prmResp.ok === false) {
      throw new Error(`OAuth PRM fetch failed (${prmResp.status})`);
    }
    const prm = ProtectedResourceMetadataSchema.parse(await prmResp.json());
    const issuer = prm.authorization_servers[0];
    if (issuer === undefined) {
      return undefined;
    }
    const asResp = await runFetch(
      `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
      { headers: { accept: "application/json" } },
    );
    if (asResp.ok === false) {
      throw new Error(`OAuth AS metadata fetch failed (${asResp.status})`);
    }
    const asMeta = AuthServerMetadataSchema.parse(await asResp.json());
    return {
      resource: prm.resource,
      tokenEndpoint: asMeta.token_endpoint,
    };
  }

  async function getToken(forceRefresh = false): Promise<string | undefined> {
    if (
      forceRefresh === false &&
      cached !== undefined &&
      Date.now() + EXPIRY_SKEW_MS < cached.expiresAtMs
    ) {
      return cached.accessToken;
    }

    const discovered = await discoverMetadata();
    if (discovered === undefined) {
      return undefined;
    }

    // Mint an RFC 8707 audience-bound token strictly scoped to this resource server.
    const tokenResp = await runFetch(discovered.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: params.config.clientId,
        resource: discovered.resource,
        scope: params.config.scopes,
        sub: params.config.subject ?? "opsdeck-host-api",
      }),
    });

    if (tokenResp.ok === false) {
      throw new Error(
        `OAuth token request to ${discovered.tokenEndpoint} failed (${tokenResp.status}): ${await tokenResp.text()}`,
      );
    }

    const parsed = TokenResponseSchema.parse(await tokenResp.json());
    const ttlMs = (parsed.expires_in ?? DEFAULT_TTL_SECS) * 1000;
    cached = {
      accessToken: parsed.access_token,
      expiresAtMs: Date.now() + ttlMs,
    };
    return cached.accessToken;
  }

  function invalidate(): void {
    cached = undefined;
  }

  return Object.freeze({
    getToken,
    invalidate,
  });
}

export { createOAuthTokenManager, extractMetadataUrlFromWwwAuth };
export type { FetchLike, OAuthClientConfig, OAuthTokenManager };
