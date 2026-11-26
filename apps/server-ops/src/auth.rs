use std::{net::IpAddr, sync::Arc};

use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use url::Url;

pub const SCOPE_READ: &str = "ops:read";
pub const SCOPE_INCIDENT_WRITE: &str = "ops:incident:write";
pub const SCOPE_DEPLOY_ROLLBACK: &str = "ops:deploy:rollback";

pub const ALL_SCOPES: [&str; 3] = [SCOPE_READ, SCOPE_INCIDENT_WRITE, SCOPE_DEPLOY_ROLLBACK];

#[derive(Clone)]
pub struct AuthConfig {
    pub resource_uri: String,
    pub metadata_uri: String,
    pub issuer: String,
    pub jwt_secret: Vec<u8>,
}

impl AuthConfig {
    pub fn new(resource_uri: String, metadata_uri: String, issuer: String, jwt_secret: Vec<u8>) -> Self {
        Self {
            resource_uri,
            metadata_uri,
            issuer,
            jwt_secret,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthClaims {
    pub sub: String,
    pub iss: String,
    pub aud: String,
    pub exp: usize,
    pub iat: usize,
    pub client_id: String,
    pub scope: String,
}

impl AuthClaims {
    pub fn has_scope(&self, required: &str) -> bool {
        self.scope.split_whitespace().any(|s| s == required)
    }
}

#[derive(Debug, Deserialize)]
pub struct DevTokenRequest {
    pub client_id: String,
    pub resource: String,
    pub scope: Option<String>,
    pub sub: Option<String>,
    pub ttl_secs: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct DevTokenResponse {
    pub access_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
    pub scope: String,
    pub resource: String,
}

fn is_disallowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0b1100_0000) == 0b0100_0000)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Validates an MCP Client ID Metadata Document (CIMD) URL against SSRF targets.
pub fn validate_cimd_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw.trim()).map_err(|err| format!("Invalid CIMD URL: {err}"))?;
    if parsed.scheme() != "https" {
        return Err("CIMD client_id URL must use https".to_owned());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("CIMD client_id URL must not contain userinfo".to_owned());
    }

    let Some(host) = parsed.host_str() else {
        return Err("CIMD client_id URL must include a host".to_owned());
    };
    let lower_host = host.to_ascii_lowercase();
    if lower_host == "localhost"
        || lower_host.ends_with(".localhost")
        || lower_host.ends_with(".local")
        || lower_host.ends_with(".internal")
    {
        return Err(format!("Disallowed internal host in CIMD URL: {host}"));
    }

    let trimmed_host = lower_host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = trimmed_host.parse::<IpAddr>()
        && is_disallowed_ip(ip)
    {
        return Err(format!("Disallowed IP address in CIMD URL: {ip}"));
    }

    if parsed.path().is_empty() || parsed.path() == "/" {
        return Err("CIMD client_id URL must specify a non-root metadata document path".to_owned());
    }

    Ok(parsed)
}

pub fn mint_token(
    config: &AuthConfig,
    client_id: &str,
    sub: &str,
    resource: &str,
    scope: &str,
    ttl_secs: i64,
) -> anyhow::Result<String> {
    let now = Utc::now().timestamp();
    let exp = (now + ttl_secs).max(0) as usize;
    let iat = now.max(0) as usize;

    let claims = AuthClaims {
        sub: sub.to_owned(),
        iss: config.issuer.clone(),
        aud: resource.to_owned(),
        exp,
        iat,
        client_id: client_id.to_owned(),
        scope: scope.to_owned(),
    };

    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(&config.jwt_secret),
    )?;
    Ok(token)
}

pub fn verify_bearer_token(config: &AuthConfig, token: &str) -> Result<AuthClaims, String> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[config.resource_uri.as_str()]);
    validation.set_issuer(&[config.issuer.as_str()]);
    validation.set_required_spec_claims(&["exp", "aud", "iss", "sub"]);

    let data = decode::<AuthClaims>(
        token,
        &DecodingKey::from_secret(&config.jwt_secret),
        &validation,
    )
    .map_err(|err| format!("Token verification failed: {err}"))?;

    Ok(data.claims)
}

fn unauthorized_response(metadata_uri: &str, error: &str, description: &str) -> Response {
    let challenge = format!(
        "Bearer resource_metadata=\"{metadata_uri}\", error=\"{error}\", error_description=\"{description}\""
    );
    let mut response = (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "error": error,
            "error_description": description,
        })),
    )
        .into_response();

    if let Ok(value) = HeaderValue::from_str(&challenge) {
        response.headers_mut().insert(header::WWW_AUTHENTICATE, value);
    }
    response
}

pub async fn bearer_auth_middleware(
    State(config): State<Arc<AuthConfig>>,
    mut req: Request,
    next: Next,
) -> Response {
    let Some(auth_header) = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|val| val.to_str().ok())
    else {
        return unauthorized_response(
            &config.metadata_uri,
            "invalid_request",
            "Missing Authorization: Bearer token",
        );
    };

    let Some(token) = auth_header.strip_prefix("Bearer ").map(str::trim) else {
        return unauthorized_response(
            &config.metadata_uri,
            "invalid_request",
            "Authorization header must use Bearer scheme",
        );
    };

    if token.is_empty() {
        return unauthorized_response(
            &config.metadata_uri,
            "invalid_token",
            "Empty Bearer token",
        );
    }

    match verify_bearer_token(&config, token) {
        Ok(claims) => {
            req.extensions_mut().insert(claims);
            next.run(req).await
        }
        Err(reason) => unauthorized_response(&config.metadata_uri, "invalid_token", &reason),
    }
}

pub async fn protected_resource_metadata(State(config): State<Arc<AuthConfig>>) -> Json<serde_json::Value> {
    Json(json!({
        "resource": config.resource_uri,
        "authorization_servers": [config.issuer],
        "scopes_supported": ALL_SCOPES,
        "bearer_methods_supported": ["header"],
        "resource_name": "OpsDeck MCP Operations Server"
    }))
}

pub async fn auth_server_metadata(State(config): State<Arc<AuthConfig>>) -> Json<serde_json::Value> {
    let issuer = config.issuer.trim_end_matches('/');
    Json(json!({
        "issuer": config.issuer,
        "token_endpoint": format!("{issuer}/auth/token"),
        "scopes_supported": ALL_SCOPES,
        "response_types_supported": ["token"],
        "grant_types_supported": ["client_credentials"],
        "token_endpoint_auth_methods_supported": ["none"],
        "client_id_metadata_document_supported": true
    }))
}

pub async fn issue_dev_token(
    State(config): State<Arc<AuthConfig>>,
    Json(body): Json<DevTokenRequest>,
) -> Response {
    let client_id = body.client_id.trim();
    if client_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_client", "error_description": "client_id is required" })),
        )
            .into_response();
    }

    if (client_id.starts_with("http://") || client_id.starts_with("https://"))
        && let Err(reason) = validate_cimd_url(client_id)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid_client_metadata", "error_description": reason })),
        )
            .into_response();
    }

    let resource = body.resource.trim();
    if resource != config.resource_uri {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_target",
                "error_description": format!("Unknown RFC 8707 resource '{resource}'")
            })),
        )
            .into_response();
    }

    let requested_scope = body.scope.unwrap_or_else(|| SCOPE_READ.to_owned());
    let ttl_secs = body.ttl_secs.unwrap_or(900).clamp(10, 3600);
    let sub = body.sub.unwrap_or_else(|| client_id.to_owned());

    match mint_token(&config, client_id, &sub, resource, &requested_scope, ttl_secs) {
        Ok(access_token) => Json(DevTokenResponse {
            access_token,
            token_type: "Bearer",
            expires_in: ttl_secs,
            scope: requested_scope,
            resource: resource.to_owned(),
        })
        .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "server_error", "error_description": err.to_string() })),
        )
            .into_response(),
    }
}
