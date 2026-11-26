package main

import (
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

const (
	scopeRead           = "ops:read"
	scopeIncidentWrite  = "ops:incident:write"
	scopeDeployRollback = "ops:deploy:rollback"
)

type GatewayClaims struct {
	ClientID string `json:"client_id"`
	Scope    string `json:"scope"`
	jwt.RegisteredClaims
}

type AuthVerifier struct {
	jwtSecret        []byte
	expectedIssuer   string
	allowedAudiences []string
	metadataURI      string
}

func NewAuthVerifier(jwtSecret []byte, expectedIssuer string, allowedAudiences []string, metadataURI string) *AuthVerifier {
	return &AuthVerifier{
		jwtSecret:        jwtSecret,
		expectedIssuer:   expectedIssuer,
		allowedAudiences: allowedAudiences,
		metadataURI:      metadataURI,
	}
}

func (c *GatewayClaims) HasScope(required string) bool {
	return slices.Contains(strings.Fields(c.Scope), required)
}

func RequiredScopeForHeaders(mcpMethod string, mcpName string) string {
	if mcpMethod == "tools/call" {
		switch mcpName {
		case "create_incident", "update_incident_status":
			return scopeIncidentWrite
		case "rollback_deployment":
			return scopeDeployRollback
		}
	}
	return scopeRead
}

func (v *AuthVerifier) VerifyRequest(r *http.Request) (*GatewayClaims, error) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return nil, errors.New("missing Authorization: Bearer token")
	}

	tokenStr, ok := strings.CutPrefix(authHeader, "Bearer ")
	if !ok {
		return nil, errors.New("authorization header must use Bearer scheme")
	}
	tokenStr = strings.TrimSpace(tokenStr)
	if tokenStr == "" {
		return nil, errors.New("empty Bearer token")
	}

	claims := &GatewayClaims{}
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(v.expectedIssuer),
		jwt.WithExpirationRequired(),
	)

	token, err := parser.ParseWithClaims(tokenStr, claims, func(_ *jwt.Token) (any, error) {
		return v.jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return nil, fmt.Errorf("invalid token: %w", err)
	}

	if !audienceMatches(claims.Audience, v.allowedAudiences) {
		return nil, fmt.Errorf("token audience %v does not match gateway resource", claims.Audience)
	}

	return claims, nil
}

func audienceMatches(tokenAud jwt.ClaimStrings, allowed []string) bool {
	for _, a := range tokenAud {
		if slices.Contains(allowed, a) {
			return true
		}
	}
	return false
}

func WriteUnauthorized(w http.ResponseWriter, metadataURI string, errCode string, description string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set(
		"WWW-Authenticate",
		fmt.Sprintf(`Bearer resource_metadata="%s", error="%s", error_description="%s"`, metadataURI, errCode, description),
	)
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = fmt.Fprintf(w, `{"error":%q,"error_description":%q}`, errCode, description)
}
