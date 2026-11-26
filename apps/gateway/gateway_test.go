package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

type stubLimiter struct {
	mu     sync.Mutex
	counts map[string]int
	limit  int
}

func newStubLimiter(limit int) *stubLimiter {
	return &stubLimiter{
		counts: make(map[string]int),
		limit:  limit,
	}
}

func (s *stubLimiter) Allow(_ context.Context, key string, _ float64, _ float64) (RateLimitDecision, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.counts[key]++
	used := s.counts[key]
	if used > s.limit {
		return RateLimitDecision{Allowed: false, Remaining: 0, RetryAfterSeconds: 2}, nil
	}
	return RateLimitDecision{Allowed: true, Remaining: int64(s.limit - used), RetryAfterSeconds: 0}, nil
}

func mintTestJWT(t *testing.T, secret []byte, issuer string, aud string, scope string) string {
	t.Helper()
	claims := GatewayClaims{
		ClientID: "https://host.opsdeck.dev/oauth/client-metadata.json",
		Scope:    scope,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   "test-operator",
			Audience:  jwt.ClaimStrings{aud},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(5 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(secret)
	if err != nil {
		t.Fatalf("failed signing test JWT: %v", err)
	}
	return signed
}

func TestGatewayHeaderRoutingScopesRateLimitAndTracePropagation(t *testing.T) {
	otel.SetTextMapPropagator(propagation.TraceContext{})
	tp := sdktrace.NewTracerProvider()
	defer func() { _ = tp.Shutdown(context.Background()) }()

	var seenTraceparent string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenTraceparent = r.Header.Get("Traceparent")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`))
	}))
	defer upstream.Close()

	upstreamURL, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatalf("parse upstream URL: %v", err)
	}

	secret := []byte("opsdeck-dev-oauth-jwt-signing-secret-32b")
	auth := NewAuthVerifier(secret, upstream.URL, []string{upstream.URL + "/mcp"}, upstream.URL+"/.well-known/oauth-protected-resource")
	limiter := newStubLimiter(2)

	handler := NewMcpGatewayHandler(
		GatewayConfig{
			UpstreamURL:       upstreamURL,
			DefaultCapacity:   2,
			DefaultRefillSec:  1,
			RollbackCapacity:  2,
			RollbackRefillSec: 1,
			AllowedMethods:    DefaultAllowedMethods(),
			BlockedTools:      map[string]bool{"dangerous_eval": true},
		},
		auth,
		limiter,
		tp.Tracer("test-gateway"),
	)

	readToken := mintTestJWT(t, secret, upstream.URL, upstream.URL+"/mcp", scopeRead)
	wrongAudToken := mintTestJWT(t, secret, upstream.URL, "https://other.example/mcp", scopeRead)

	cases := []struct {
		name       string
		method     string
		mcpMethod  string
		mcpName    string
		token      string
		wantStatus int
	}{
		{
			name:       "missing Mcp-Method rejected",
			method:     http.MethodPost,
			mcpMethod:  "",
			token:      readToken,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "disallowed Mcp-Method rejected without upstream call",
			method:     http.MethodPost,
			mcpMethod:  "sampling/createMessage",
			token:      readToken,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "blocked tool rejected via Mcp-Name header",
			method:     http.MethodPost,
			mcpMethod:  "tools/call",
			mcpName:    "dangerous_eval",
			token:      readToken,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "wrong RFC 8707 audience rejected",
			method:     http.MethodPost,
			mcpMethod:  "tools/list",
			token:      wrongAudToken,
			wantStatus: http.StatusUnauthorized,
		},
		{
			name:       "insufficient scope for rollback_deployment rejected via Mcp-Name",
			method:     http.MethodPost,
			mcpMethod:  "tools/call",
			mcpName:    "rollback_deployment",
			token:      readToken,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "valid read request passes and injects traceparent (1/2)",
			method:     http.MethodPost,
			mcpMethod:  "tools/call",
			mcpName:    "get_service_detail",
			token:      readToken,
			wantStatus: http.StatusOK,
		},
		{
			name:       "valid read request passes (2/2)",
			method:     http.MethodPost,
			mcpMethod:  "tools/call",
			mcpName:    "get_service_detail",
			token:      readToken,
			wantStatus: http.StatusOK,
		},
		{
			name:       "third request triggers 429 rate limit",
			method:     http.MethodPost,
			mcpMethod:  "tools/call",
			mcpName:    "get_service_detail",
			token:      readToken,
			wantStatus: http.StatusTooManyRequests,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1}`))
			if tc.mcpMethod != "" {
				req.Header.Set("Mcp-Method", tc.mcpMethod)
			}
			if tc.mcpName != "" {
				req.Header.Set("Mcp-Name", tc.mcpName)
			}
			if tc.token != "" {
				req.Header.Set("Authorization", "Bearer "+tc.token)
			}
			req.Header.Set("Mcp-Param-Service", "checkout-api")
			req.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")

			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			resp := rec.Result()
			defer func() { _ = resp.Body.Close() }()
			_, _ = io.ReadAll(resp.Body)

			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("status=%d want=%d", resp.StatusCode, tc.wantStatus)
			}
			if tc.wantStatus == http.StatusTooManyRequests && resp.Header.Get("Retry-After") == "" {
				t.Fatalf("expected Retry-After header on 429 response")
			}
		})
	}

	if !strings.HasPrefix(seenTraceparent, "00-4bf92f3577b34da6a3ce929d0e0e4736-") {
		t.Fatalf("expected W3C traceparent propagated upstream, got %q", seenTraceparent)
	}
}
