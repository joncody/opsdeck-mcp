package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.34.0"
)

func envOrDefault(key string, fallback string) string {
	val := strings.TrimSpace(os.Getenv(key))
	if val == "" {
		return fallback
	}
	return val
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func initTracerProvider(ctx context.Context, otlpEndpoint string) (*sdktrace.TracerProvider, error) {
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	exporter, err := otlptracegrpc.New(
		ctx,
		otlptracegrpc.WithEndpoint(otlpEndpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil {
		return nil, err
	}

	res, err := resource.New(
		ctx,
		resource.WithAttributes(
			semconv.ServiceName("opsdeck-gateway"),
			semconv.ServiceVersion("0.1.0"),
		),
	)
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	return tp, nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	listenAddr := envOrDefault("GATEWAY_ADDR", ":8090")
	upstreamRaw := envOrDefault("UPSTREAM_OPS_URL", "http://127.0.0.1:8080")
	redisAddr := envOrDefault("REDIS_ADDR", "127.0.0.1:6379")
	otlpEndpoint := envOrDefault("OTEL_EXPORTER_OTLP_ENDPOINT", "127.0.0.1:4317")
	jwtSecret := envOrDefault("OAUTH_JWT_SECRET", "opsdeck-dev-oauth-jwt-signing-secret-32b")
	expectedIssuer := envOrDefault("OAUTH_ISSUER", upstreamRaw)
	audiences := splitCSV(envOrDefault(
		"GATEWAY_AUDIENCES",
		"http://127.0.0.1:8090/mcp,http://127.0.0.1:8080/mcp",
	))
	blockedTools := make(map[string]bool)
	for _, name := range splitCSV(os.Getenv("GATEWAY_BLOCKED_TOOLS")) {
		blockedTools[name] = true
	}

	upstreamURL, err := url.Parse(upstreamRaw)
	if err != nil {
		log.Fatalf("invalid UPSTREAM_OPS_URL %q: %v", upstreamRaw, err)
	}

	tp, err := initTracerProvider(ctx, otlpEndpoint)
	if err != nil {
		log.Printf("[gateway] OTel exporter disabled (%v); using no-op spans", err)
	} else {
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := tp.Shutdown(shutdownCtx); err != nil {
				log.Printf("[gateway] OTel shutdown warning: %v", err)
			}
		}()
	}

	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer func() {
		if err := rdb.Close(); err != nil {
			log.Printf("[gateway] redis close warning: %v", err)
		}
	}()

	pingCtx, cancelPing := context.WithTimeout(ctx, 2*time.Second)
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		log.Printf("[gateway] warning: Redis ping to %s failed (%v)", redisAddr, err)
	}
	cancelPing()

	limiter := NewRedisTokenBucketLimiter(rdb, "opsdeck:rl")
	metadataURI := strings.TrimRight(upstreamRaw, "/") + "/.well-known/oauth-protected-resource"
	auth := NewAuthVerifier([]byte(jwtSecret), expectedIssuer, audiences, metadataURI)

	mcpHandler := NewMcpGatewayHandler(
		GatewayConfig{
			UpstreamURL:       upstreamURL,
			DefaultCapacity:   30,
			DefaultRefillSec:  5,
			RollbackCapacity:  3,
			RollbackRefillSec: 0.2,
			AllowedMethods:    DefaultAllowedMethods(),
			BlockedTools:      blockedTools,
		},
		auth,
		limiter,
		otel.Tracer("opsdeck-gateway"),
	)

	passthroughProxy := httputil.NewSingleHostReverseProxy(upstreamURL)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true,"service":"opsdeck-gateway"}`))
	})
	mux.Handle("/.well-known/", passthroughProxy)
	mux.Handle("/auth/", passthroughProxy)
	mux.Handle("/mcp", mcpHandler)

	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("[gateway] HTTP shutdown error: %v", err)
		}
	}()

	log.Printf("[gateway] listening on %s -> upstream %s (redis=%s, otlp=%s)", listenAddr, upstreamRaw, redisAddr, otlpEndpoint)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[gateway] listen failed: %v", err)
	}
}
