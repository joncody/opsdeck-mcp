use std::sync::Arc;

use axum::{
    Json, Router,
    extract::Request,
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
};
use opentelemetry::trace::TracerProvider as _;
use opentelemetry_http::HeaderExtractor;
use opentelemetry_otlp::SpanExporter;
use opentelemetry_sdk::{Resource, propagation::TraceContextPropagator, trace::SdkTracerProvider};
use opsdeck_server_ops::{
    auth::{
        AuthConfig, auth_server_metadata, bearer_auth_middleware, issue_dev_token,
        protected_resource_metadata,
    },
    db::OpsStore,
    server::OpsServer,
};
use rmcp::{
    ServiceExt,
    transport::{
        stdio,
        streamable_http_server::{
            StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
        },
    },
};
use serde_json::json;
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

const DEFAULT_DATABASE_URL: &str = "postgres://opsdeck:opsdeck@127.0.0.1:5432/opsdeck";
const DEFAULT_HTTP_BIND: &str = "127.0.0.1:8080";
const DEFAULT_DEV_STATE_SECRET: &str = "opsdeck-dev-request-state-secret-32b";
const DEFAULT_DEV_JWT_SECRET: &str = "opsdeck-dev-oauth-jwt-signing-secret-32b";

fn init_tracing(enable_otlp: bool) -> Option<SdkTracerProvider> {
    opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("opsdeck_server_ops=info,rmcp=warn"));

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_ansi(false);

    if !enable_otlp {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
        return None;
    }

    match SpanExporter::builder().with_tonic().build() {
        Ok(exporter) => {
            let provider = SdkTracerProvider::builder()
                .with_batch_exporter(exporter)
                .with_resource(
                    Resource::builder()
                        .with_service_name("opsdeck-server-ops")
                        .build(),
                )
                .build();

            let tracer = provider.tracer("opsdeck-server-ops");
            opentelemetry::global::set_tracer_provider(provider.clone());

            tracing_subscriber::registry()
                .with(filter)
                .with(fmt_layer)
                .with(tracing_opentelemetry::layer().with_tracer(tracer))
                .init();

            Some(provider)
        }
        Err(err) => {
            tracing_subscriber::registry()
                .with(filter)
                .with(fmt_layer)
                .init();
            tracing::warn!("OTLP span exporter unavailable ({err}); continuing with stderr logs");
            None
        }
    }
}

async fn otel_trace_middleware(req: Request, next: Next) -> Response {
    let parent_cx = opentelemetry::global::get_text_map_propagator(|prop| {
        prop.extract(&HeaderExtractor(req.headers()))
    });

    let mcp_method = req
        .headers()
        .get("mcp-method")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let mcp_name = req
        .headers()
        .get("mcp-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let mcp_service = req
        .headers()
        .get("mcp-param-service")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let span = tracing::info_span!(
        "server_ops.mcp",
        otel.kind = "server",
        mcp.method = %mcp_method,
        mcp.name = %mcp_name,
        mcp.param.service = %mcp_service,
    );
    let _ = span.set_parent(parent_cx);

    next.run(req).instrument(span).await
}

async fn healthz() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "service": "opsdeck-server-ops" }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let use_stdio = std::env::args().any(|arg| arg == "--stdio")
        || std::env::var("MCP_TRANSPORT").is_ok_and(|val| val == "stdio");

    let otel_provider = init_tracing(!use_stdio);

    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_owned());
    let state_secret = match std::env::var("REQUEST_STATE_SECRET") {
        Ok(val) if val.len() >= 32 => val.into_bytes(),
        _ => {
            tracing::warn!(
                "REQUEST_STATE_SECRET missing or < 32 bytes; using development signing key"
            );
            DEFAULT_DEV_STATE_SECRET.as_bytes().to_vec()
        }
    };
    let jwt_secret = match std::env::var("OAUTH_JWT_SECRET") {
        Ok(val) if val.len() >= 32 => val.into_bytes(),
        _ => {
            tracing::warn!(
                "OAUTH_JWT_SECRET missing or < 32 bytes; using development JWT signing key"
            );
            DEFAULT_DEV_JWT_SECRET.as_bytes().to_vec()
        }
    };

    let store = OpsStore::connect(&database_url).await?;
    let server = OpsServer::with_secret(store, &state_secret)?;

    if use_stdio {
        tracing::info!("serving OpsDeck MCP over stdio");
        let running = server.serve(stdio()).await?;
        running.waiting().await?;
        return Ok(());
    }

    let bind_addr = std::env::var("MCP_BIND_ADDR").unwrap_or_else(|_| DEFAULT_HTTP_BIND.to_owned());
    let public_base =
        std::env::var("OPS_PUBLIC_BASE_URL").unwrap_or_else(|_| format!("http://{bind_addr}"));
    let trimmed_base = public_base.trim_end_matches('/');

    let auth_config = Arc::new(AuthConfig::new(
        format!("{trimmed_base}/mcp"),
        format!("{trimmed_base}/.well-known/oauth-protected-resource"),
        trimmed_base.to_owned(),
        jwt_secret,
    ));

    let http_config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true);

    let mcp_service = StreamableHttpService::new(
        move || Ok(server.clone()),
        LocalSessionManager::default().into(),
        http_config,
    );

    let protected_mcp = Router::new()
        .nest_service("/mcp", mcp_service)
        .layer(middleware::from_fn_with_state(
            auth_config.clone(),
            bearer_auth_middleware,
        ))
        .layer(middleware::from_fn(otel_trace_middleware));

    let router = Router::new()
        .route("/healthz", get(healthz))
        .route(
            "/.well-known/oauth-protected-resource",
            get(protected_resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(protected_resource_metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(auth_server_metadata),
        )
        .route("/auth/token", post(issue_dev_token))
        .with_state(auth_config)
        .merge(protected_mcp);

    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!(
        "serving OpsDeck MCP (2026-07-28 OAuth 2.1 + OTel Streamable HTTP) at {trimmed_base}/mcp"
    );

    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;

    if let Some(provider) = otel_provider {
        let _ = provider.shutdown();
    }

    Ok(())
}
