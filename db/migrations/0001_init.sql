CREATE TABLE IF NOT EXISTS services (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL CHECK (tier IN ('tier0', 'tier1', 'tier2')),
    owner_team TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'down')),
    current_version TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deployments (
    id UUID PRIMARY KEY,
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'rolled_back', 'failed')),
    deployed_by TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deployments_service_time
    ON deployments (service_id, deployed_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
    id UUID PRIMARY KEY,
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
    status TEXT NOT NULL CHECK (status IN ('open', 'mitigating', 'resolved')),
    summary TEXT NOT NULL,
    commander TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_incidents_status_severity
    ON incidents (status, severity, created_at DESC);

CREATE TABLE IF NOT EXISTS runbooks (
    id UUID PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    service_id UUID REFERENCES services(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('deployment', 'database', 'rate-limiting', 'auth', 'incident')),
    content_md TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed services
INSERT INTO services (id, name, tier, owner_team, repo_url, status, current_version, updated_at)
VALUES
    ('11111111-1111-4111-8111-111111111101', 'checkout-api', 'tier0', 'commerce-core', 'https://github.com/opsdeck/checkout-api', 'degraded', 'v2.14.3', NOW() - INTERVAL '25 minutes'),
    ('11111111-1111-4111-8111-111111111102', 'auth-gateway', 'tier0', 'identity-platform', 'https://github.com/opsdeck/auth-gateway', 'healthy', 'v4.8.1', NOW() - INTERVAL '2 days'),
    ('11111111-1111-4111-8111-111111111103', 'payments-worker', 'tier0', 'billing-infra', 'https://github.com/opsdeck/payments-worker', 'healthy', 'v3.2.0', NOW() - INTERVAL '5 days'),
    ('11111111-1111-4111-8111-111111111104', 'search-indexer', 'tier1', 'discovery', 'https://github.com/opsdeck/search-indexer', 'degraded', 'v1.19.4', NOW() - INTERVAL '4 hours'),
    ('11111111-1111-4111-8111-111111111105', 'notification-hub', 'tier2', 'comms', 'https://github.com/opsdeck/notification-hub', 'healthy', 'v1.6.2', NOW() - INTERVAL '9 days')
ON CONFLICT (id) DO NOTHING;

-- Seed deployments (checkout-api has a clear rollback target v2.14.2)
INSERT INTO deployments (id, service_id, version, environment, status, deployed_by, commit_sha, notes, deployed_at)
VALUES
    ('22222222-2222-4222-8222-222222222201', '11111111-1111-4111-8111-111111111101', 'v2.14.2', 'production', 'rolled_back', 'ci-bot', 'a91f3c2', 'Previous stable baseline', NOW() - INTERVAL '3 days'),
    ('22222222-2222-4222-8222-222222222202', '11111111-1111-4111-8111-111111111101', 'v2.14.3', 'production', 'active', 'alice@opsdeck.dev', 'f40c81d', 'Added Stripe 3DS retry middleware', NOW() - INTERVAL '30 minutes'),
    ('22222222-2222-4222-8222-222222222203', '11111111-1111-4111-8111-111111111102', 'v4.8.1', 'production', 'active', 'bob@opsdeck.dev', '9c112ab', 'Enabled RFC 9728 protected resource metadata', NOW() - INTERVAL '2 days'),
    ('22222222-2222-4222-8222-222222222204', '11111111-1111-4111-8111-111111111103', 'v3.2.0', 'production', 'active', 'ci-bot', '71de044', 'Idempotency key TTL bump to 24h', NOW() - INTERVAL '5 days'),
    ('22222222-2222-4222-8222-222222222205', '11111111-1111-4111-8111-111111111104', 'v1.19.4', 'production', 'active', 'carol@opsdeck.dev', '3b8a190', 'Increased batch chunk size to 500', NOW() - INTERVAL '6 hours')
ON CONFLICT (id) DO NOTHING;

-- Seed incidents
INSERT INTO incidents (id, service_id, title, severity, status, summary, commander, created_at, resolved_at)
VALUES
    ('33333333-3333-4333-8333-333333333301', '11111111-1111-4111-8111-111111111101', 'Elevated 502s and DB pool saturation after v2.14.3', 'sev1', 'open', 'p99 latency jumped from 120ms to 4.8s right after checkout-api v2.14.3 rollout; Postgres connection wait queue spiking.', 'alice@opsdeck.dev', NOW() - INTERVAL '22 minutes', NULL),
    ('33333333-3333-4333-8333-333333333302', '11111111-1111-4111-8111-111111111104', 'Search indexing lag > 15m on US-East shard', 'sev2', 'mitigating', 'Batch chunk increase to 500 caused Redis rate-limit rejections on embedding enrichment worker.', 'carol@opsdeck.dev', NOW() - INTERVAL '3 hours', NULL),
    ('33333333-3333-4333-8333-333333333303', '11111111-1111-4111-8111-111111111102', 'Intermittent 401s during JWKS key rotation', 'sev3', 'resolved', 'Edge cache served stale JWKS for 90s; resolved after lowering max-age to 30s and forcing key reload.', 'bob@opsdeck.dev', NOW() - INTERVAL '4 days', NOW() - INTERVAL '3 days 22 hours')
ON CONFLICT (id) DO NOTHING;

-- Seed runbooks
INSERT INTO runbooks (id, slug, service_id, title, category, content_md, updated_at)
VALUES
    (
        '44444444-4444-4444-8444-444444444401',
        'rollback-procedure',
        '11111111-1111-4111-8111-111111111101',
        'Production Deployment Rollback Procedure',
        'deployment',
        E'# Production Deployment Rollback Procedure\n\n## Trigger Conditions\n- Error rate > 2% for 5 minutes post-deploy\n- SEV1/SEV2 incident correlated with recent deployment\n\n## Steps\n1. Confirm the target previous stable version via `ops://services/checkout-api` or deployment history.\n2. Verify no destructive forward-only schema migration shipped in the bad release.\n3. Execute `rollback_deployment` with explicit human confirmation.\n4. Monitor p99 latency and error rate in Jaeger/Prometheus for 10 minutes.\n5. Update the active incident status to `mitigating` or `resolved`.',
        NOW() - INTERVAL '7 days'
    ),
    (
        '44444444-4444-4444-8444-444444444402',
        'pg-pool-exhaustion',
        '11111111-1111-4111-8111-111111111101',
        'PostgreSQL Connection Pool Exhaustion Triage',
        'database',
        E'# PostgreSQL Connection Pool Exhaustion Triage\n\n## Symptoms\n- `pool timed out while waiting for an open connection`\n- Elevated p99 latency without CPU saturation\n\n## Mitigation\n1. Check recent deployments for leaked transactions or N+1 query loops.\n2. Inspect `pg_stat_activity` for `idle in transaction` sessions > 30s.\n3. Roll back the offending release if correlated within 60 minutes.',
        NOW() - INTERVAL '14 days'
    ),
    (
        '44444444-4444-4444-8444-444444444403',
        'redis-rate-limit-spike',
        '11111111-1111-4111-8111-111111111104',
        'Redis Token-Bucket Rate Limit Spike Mitigation',
        'rate-limiting',
        E'# Redis Token-Bucket Rate Limit Spike Mitigation\n\n## Symptoms\n- HTTP 429 responses from gateway with `Retry-After` headers\n\n## Mitigation\n1. Identify caller client_id or MCP tool generating burst traffic.\n2. Reduce worker batch concurrency before requesting temporary quota elevation.\n3. Verify Redis memory and key eviction metrics.',
        NOW() - INTERVAL '10 days'
    ),
    (
        '44444444-4444-4444-8444-444444444404',
        'oauth-jwks-rotation',
        '11111111-1111-4111-8111-111111111102',
        'OAuth 2.1 JWKS Key Rotation & Audience Audit',
        'auth',
        E'# OAuth 2.1 JWKS Key Rotation & Audience Audit\n\n## Checklist\n- Publish new JWK alongside old JWK at least 24h before signing cutover.\n- Enforce RFC 8707 `aud` claim matching the server Protected Resource Metadata (`/.well-known/oauth-protected-resource`).\n- Never forward client tokens to downstream upstreams (no token passthrough).',
        NOW() - INTERVAL '20 days'
    )
ON CONFLICT (id) DO NOTHING;
