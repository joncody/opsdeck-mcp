package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestRedisTokenBucketIntegration(t *testing.T) {
	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "127.0.0.1:6379"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	client := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer func() {
		_ = client.Close()
	}()

	if err := client.Ping(ctx).Err(); err != nil {
		t.Skipf("skipping live Redis integration test (%s unreachable: %v)", redisAddr, err)
	}

	prefix := fmt.Sprintf("opsdeck:test:%d", time.Now().UnixNano())
	bucketKey := "client-a:tools/call:rollback_deployment"
	fullRedisKey := prefix + ":" + bucketKey
	defer func() {
		_ = client.Del(context.Background(), fullRedisKey).Err()
	}()

	limiter := NewRedisTokenBucketLimiter(client, prefix)

	// Burst of 3 succeeds
	for i := range 3 {
		decision, err := limiter.Allow(ctx, bucketKey, 3, 0.5)
		if err != nil {
			t.Fatalf("allow call %d failed: %v", i+1, err)
		}
		if !decision.Allowed {
			t.Fatalf("expected call %d to be allowed", i+1)
		}
		wantRemaining := int64(2 - i)
		if decision.Remaining != wantRemaining {
			t.Fatalf("call %d remaining=%d want=%d", i+1, decision.Remaining, wantRemaining)
		}
	}

	// 4th immediate call must be throttled with Retry-After >= 1
	denied, err := limiter.Allow(ctx, bucketKey, 3, 0.5)
	if err != nil {
		t.Fatalf("denied check failed: %v", err)
	}
	if denied.Allowed {
		t.Fatalf("expected 4th request to be denied by token bucket")
	}
	if denied.RetryAfterSeconds < 1 {
		t.Fatalf("expected RetryAfterSeconds >= 1, got %d", denied.RetryAfterSeconds)
	}
}
