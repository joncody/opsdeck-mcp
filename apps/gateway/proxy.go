package main

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

type GatewayConfig struct {
	UpstreamURL       *url.URL
	DefaultCapacity   float64
	DefaultRefillSec  float64
	RollbackCapacity  float64
	RollbackRefillSec float64
	AllowedMethods    map[string]bool
	BlockedTools      map[string]bool
}

func DefaultAllowedMethods() map[string]bool {
	return map[string]bool{
		"server/discover":           true,
		"initialize":                true,
		"notifications/initialized": true,
		"tools/list":                true,
		"tools/call":                true,
		"resources/list":            true,
		"resources/templates/list":  true,
		"resources/read":            true,
		"prompts/list":              true,
		"prompts/get":               true,
		"tasks/get":                 true,
		"tasks/cancel":              true,
		"ping":                      true,
	}
}

func writeJSONError(w http.ResponseWriter, status int, code string, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"error":%q,"message":%q}`, code, message)
}

func NewMcpGatewayHandler(
	cfg GatewayConfig,
	auth *AuthVerifier,
	limiter RateLimiter,
	tracer trace.Tracer,
) http.Handler {
	proxy := httputil.NewSingleHostReverseProxy(cfg.UpstreamURL)
	baseDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		baseDirector(req)
		req.Host = cfg.UpstreamURL.Host
		otel.GetTextMapPropagator().Inject(req.Context(), propagation.HeaderCarrier(req.Header))
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		span := trace.SpanFromContext(r.Context())
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		writeJSONError(w, http.StatusBadGateway, "upstream_unavailable", err.Error())
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		extractedCtx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))

		mcpMethod := strings.TrimSpace(r.Header.Get("Mcp-Method"))
		mcpName := strings.TrimSpace(r.Header.Get("Mcp-Name"))
		mcpService := strings.TrimSpace(r.Header.Get("Mcp-Param-Service"))

		ctx, span := tracer.Start(
			extractedCtx,
			"gateway.mcp",
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("http.method", r.Method),
				attribute.String("mcp.method", mcpMethod),
				attribute.String("mcp.name", mcpName),
				attribute.String("mcp.param.service", mcpService),
			),
		)
		defer span.End()

		r = r.WithContext(ctx)

		// 1. Header-based routing & allowlist without reading/buffering JSON-RPC body
		if r.Method == http.MethodPost {
			if mcpMethod == "" {
				span.SetStatus(codes.Error, "missing Mcp-Method header")
				writeJSONError(w, http.StatusBadRequest, "missing_mcp_method", "2026-07-28 POST /mcp requires Mcp-Method header")
				return
			}
			if !cfg.AllowedMethods[mcpMethod] {
				span.SetStatus(codes.Error, "disallowed Mcp-Method")
				writeJSONError(w, http.StatusForbidden, "method_not_allowed", fmt.Sprintf("MCP method %q is blocked by gateway policy", mcpMethod))
				return
			}
			if mcpMethod == "tools/call" && cfg.BlockedTools[mcpName] {
				span.SetStatus(codes.Error, "blocked tool")
				writeJSONError(w, http.StatusForbidden, "tool_not_allowed", fmt.Sprintf("MCP tool %q is blocked by gateway policy", mcpName))
				return
			}
		}

		// 2. OAuth 2.1 Bearer JWT verification & header-derived scope check
		claims, err := auth.VerifyRequest(r)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "unauthorized")
			WriteUnauthorized(w, auth.metadataURI, "invalid_token", err.Error())
			return
		}
		span.SetAttributes(
			attribute.String("oauth.client_id", claims.ClientID),
			attribute.String("oauth.sub", claims.Subject),
		)

		requiredScope := RequiredScopeForHeaders(mcpMethod, mcpName)
		if !claims.HasScope(requiredScope) {
			span.SetStatus(codes.Error, "insufficient_scope")
			w.Header().Set(
				"WWW-Authenticate",
				fmt.Sprintf(`Bearer resource_metadata="%s", error="insufficient_scope", scope="%s"`, auth.metadataURI, requiredScope),
			)
			writeJSONError(w, http.StatusForbidden, "insufficient_scope", fmt.Sprintf("Scope %q required for %s %s", requiredScope, mcpMethod, mcpName))
			return
		}

		// 3. Redis token-bucket rate limiting keyed by client_id + method + tool
		bucketKey := fmt.Sprintf("%s:%s:%s", claims.ClientID, mcpMethod, mcpName)
		capacity := cfg.DefaultCapacity
		refill := cfg.DefaultRefillSec
		if mcpMethod == "tools/call" && mcpName == "rollback_deployment" {
			capacity = cfg.RollbackCapacity
			refill = cfg.RollbackRefillSec
		}

		decision, err := limiter.Allow(ctx, bucketKey, capacity, refill)
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "rate_limiter_error")
			writeJSONError(w, http.StatusServiceUnavailable, "rate_limiter_unavailable", err.Error())
			return
		}

		w.Header().Set("X-RateLimit-Remaining", strconv.FormatInt(decision.Remaining, 10))
		if !decision.Allowed {
			w.Header().Set("Retry-After", strconv.FormatInt(decision.RetryAfterSeconds, 10))
			span.SetStatus(codes.Error, "rate_limited")
			writeJSONError(w, http.StatusTooManyRequests, "rate_limit_exceeded", "Token bucket exhausted; retry later")
			return
		}

		// 4. Stream request transparently upstream with W3C traceparent injected
		proxy.ServeHTTP(w, r)
	})
}
