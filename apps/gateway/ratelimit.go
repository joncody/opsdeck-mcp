package main

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/redis/go-redis/v9"
)

type RateLimitDecision struct {
	Allowed           bool
	Remaining         int64
	RetryAfterSeconds int64
}

type RateLimiter interface {
	Allow(ctx context.Context, key string, capacity float64, refillPerSec float64) (RateLimitDecision, error)
}

var tokenBucketScript = redis.NewScript(`
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local requested = 1

local data = redis.call("HMGET", key, "tokens", "ts")
local tokens = tonumber(data[1])
local last_ts = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_ts = now_ms
else
  local elapsed_sec = math.max(0, (now_ms - last_ts) / 1000.0)
  tokens = math.min(capacity, tokens + (elapsed_sec * refill_per_sec))
  last_ts = now_ms
end

local allowed = 0
local retry_after = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  local deficit = requested - tokens
  retry_after = math.ceil(deficit / refill_per_sec)
end

local ttl_sec = math.max(10, math.ceil((capacity / refill_per_sec) * 2))
redis.call("HSET", key, "tokens", tostring(tokens), "ts", tostring(last_ts))
redis.call("EXPIRE", key, ttl_sec)

return { allowed, math.floor(tokens), retry_after }
`)

type RedisTokenBucketLimiter struct {
	client *redis.Client
	prefix string
}

func NewRedisTokenBucketLimiter(client *redis.Client, prefix string) *RedisTokenBucketLimiter {
	return &RedisTokenBucketLimiter{
		client: client,
		prefix: prefix,
	}
}

func (l *RedisTokenBucketLimiter) Allow(
	ctx context.Context,
	key string,
	capacity float64,
	refillPerSec float64,
) (RateLimitDecision, error) {
	if capacity <= 0 || refillPerSec <= 0 {
		return RateLimitDecision{}, fmt.Errorf("invalid token bucket configuration: capacity=%v refill=%v", capacity, refillPerSec)
	}

	nowMs := time.Now().UnixMilli()
	namespaced := fmt.Sprintf("%s:%s", l.prefix, key)

	res, err := tokenBucketScript.Run(ctx, l.client, []string{namespaced}, capacity, refillPerSec, nowMs).Slice()
	if err != nil {
		return RateLimitDecision{}, err
	}
	if len(res) != 3 {
		return RateLimitDecision{}, fmt.Errorf("unexpected redis lua response length: %d", len(res))
	}

	allowedInt, ok1 := res[0].(int64)
	remainingInt, ok2 := res[1].(int64)
	retryInt, ok3 := res[2].(int64)
	if !ok1 || !ok2 || !ok3 {
		return RateLimitDecision{}, fmt.Errorf("unexpected redis lua return types: %#v", res)
	}

	return RateLimitDecision{
		Allowed:           allowedInt == 1,
		Remaining:         int64(math.Max(0, float64(remainingInt))),
		RetryAfterSeconds: retryInt,
	}, nil
}
