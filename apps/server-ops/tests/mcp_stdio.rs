use std::sync::Arc;

use axum::{Router, middleware};
use opsdeck_server_ops::{
    auth::{ALL_SCOPES, AuthConfig, bearer_auth_middleware, mint_token},
    db::OpsStore,
    server::OpsServer,
};
use rmcp::{
    ClientLifecycleMode, ClientServiceExt, ServiceError, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CancelTaskParams, ClientCapabilities, ClientConfig,
        ErrorCode, GetPromptRequestParams, GetTaskParams, Implementation, InputResponses,
        ProtocolVersion, ReadResourceRequestParams, ResultType, TaskStatus,
    },
    transport::{
        StreamableHttpClientTransport,
        streamable_http_client::StreamableHttpClientTransportConfig,
        streamable_http_server::{
            StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
        },
    },
};

const DEFAULT_DATABASE_URL: &str = "postgres://opsdeck:opsdeck@127.0.0.1:5432/opsdeck";
const TEST_STATE_SECRET: &[u8] = b"opsdeck-dev-request-state-secret-32b";
const TEST_JWT_SECRET: &[u8] = b"opsdeck-dev-oauth-jwt-signing-secret-32b";

fn test_database_url() -> String {
    std::env::var("DATABASE_URL").unwrap_or_else(|_| DEFAULT_DATABASE_URL.to_owned())
}

#[tokio::test]
async fn protocol_primitives_and_errors_over_duplex() -> anyhow::Result<()> {
    let store = OpsStore::connect_lazy(&test_database_url())?;
    let server = OpsServer::with_secret(store, TEST_STATE_SECRET)?;

    let (server_io, client_io) = tokio::io::duplex(64 * 1024);
    let (server_read, server_write) = tokio::io::split(server_io);
    let (client_read, client_write) = tokio::io::split(client_io);

    let server_task = tokio::spawn(async move {
        let running = server.serve((server_read, server_write)).await?;
        running.waiting().await?;
        Ok::<_, anyhow::Error>(())
    });

    let client = ().serve((client_read, client_write)).await?;

    let tools = client.list_all_tools().await?;
    let tool_names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
    assert!(tool_names.contains(&"list_services"));
    assert!(tool_names.contains(&"rollback_deployment"));
    assert!(tool_names.contains(&"run_diagnostic_probe"));

    let rollback_tool = tools
        .iter()
        .find(|t| t.name == "rollback_deployment")
        .expect("rollback_deployment tool present");
    let props = rollback_tool
        .input_schema
        .get("properties")
        .and_then(|v| v.as_object())
        .expect("properties object");
    assert_eq!(
        props
            .get("service_name")
            .and_then(|v| v.get("x-mcp-header"))
            .and_then(|v| v.as_str()),
        Some("Service")
    );

    let bad_status = client
        .call_tool(
            CallToolRequestParams::new("list_services")
                .with_arguments(rmcp::object!({ "status": "exploding" })),
        )
        .await?;
    assert_eq!(bad_status.is_error, Some(true));

    let empty_err = client
        .call_tool(
            CallToolRequestParams::new("get_service_detail")
                .with_arguments(rmcp::object!({ "service_name": "   " })),
        )
        .await
        .expect_err("empty service_name must fail with invalid_params");
    match empty_err {
        ServiceError::McpError(data) => assert_eq!(data.code, ErrorCode::INVALID_PARAMS),
        other => panic!("unexpected error variant: {other:?}"),
    }

    let resources = client.list_all_resources().await?;
    assert!(resources.iter().any(|r| r.uri == "ops://services"));
    assert!(resources.iter().any(|r| r.uri == "ops://incidents/open"));
    assert!(resources.iter().any(|r| r.uri == "ops://runbooks"));

    let templates = client.list_all_resource_templates().await?;
    assert!(templates.iter().any(|t| t.uri_template == "ops://services/{name}"));
    assert!(templates.iter().any(|t| t.uri_template == "ops://runbooks/{slug}"));

    let unknown_res = client
        .read_resource(ReadResourceRequestParams::new("ops://unknown/thing"))
        .await
        .expect_err("unknown URI must fail with resource_not_found");
    match unknown_res {
        ServiceError::McpError(data) => assert_eq!(data.code, ErrorCode::RESOURCE_NOT_FOUND),
        other => panic!("unexpected error variant: {other:?}"),
    }

    let prompts = client.list_all_prompts().await?;
    assert!(prompts.iter().any(|p| p.name == "triage_incident"));
    let prompt_res = client
        .get_prompt(
            GetPromptRequestParams::new("triage_incident").with_arguments(rmcp::object!({
                "incident_id": "33333333-3333-4333-8333-333333333301",
                "focus": "database"
            })),
        )
        .await?;
    assert_eq!(prompt_res.messages.len(), 1);

    client.cancel().await?;
    server_task.await??;
    Ok(())
}

#[tokio::test]
async fn stateless_2026_07_28_discover_and_tasks_cancel_over_http() -> anyhow::Result<()> {
    let store = OpsStore::connect_lazy(&test_database_url())?;
    let server = OpsServer::with_secret(store, TEST_STATE_SECRET)?;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let base_url = format!("http://{addr}");

    let auth_config = Arc::new(AuthConfig::new(
        format!("{base_url}/mcp"),
        format!("{base_url}/.well-known/oauth-protected-resource"),
        base_url.clone(),
        TEST_JWT_SECRET.to_vec(),
    ));

    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true);
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        LocalSessionManager::default().into(),
        config,
    );
    let router = Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(
            auth_config.clone(),
            bearer_auth_middleware,
        ));

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server_task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
    });

    let token = mint_token(
        &auth_config,
        "https://host.opsdeck.dev/oauth/client.json",
        "opsdeck-host-api",
        &auth_config.resource_uri,
        &ALL_SCOPES.join(" "),
        300,
    )?;

    let mut transport_cfg = StreamableHttpClientTransportConfig::with_uri(format!("{base_url}/mcp"));
    transport_cfg.auth_header = Some(token);
    let transport = StreamableHttpClientTransport::from_config(transport_cfg);

    let client_config = ClientConfig::new(
        ClientCapabilities::builder().enable_tasks().build(),
        Implementation::from_build_env(),
    );
    let client = client_config
        .serve_with_lifecycle(
            transport,
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        )
        .await?;

    let peer_info = client.peer_info().expect("server peer info negotiated");
    assert_eq!(peer_info.protocol_version, ProtocolVersion::V_2026_07_28);

    // Fetch tools/list first so SEP-2243 x-mcp-header mappings (Mcp-Param-Service) are cached
    let _tools = client.list_all_tools().await?;

    let complete_err = client
        .call_tool_once(
            CallToolRequestParams::new("list_services")
                .with_arguments(rmcp::object!({ "status": "bogus" })),
        )
        .await?;
    match complete_err {
        CallToolResponse::Complete(result) => {
            assert_eq!(result.result_type, Some(ResultType::COMPLETE));
            assert_eq!(result.is_error, Some(true));
        }
        other => panic!("expected Complete response, got {other:?}"),
    }

    // Tampered requestState on rollback_deployment is rejected with INVALID_PARAMS (-32602)
    let tampered_err = client
        .call_tool_once(
            CallToolRequestParams::new("rollback_deployment")
                .with_arguments(rmcp::object!({
                    "service_name": "checkout-api",
                    "target_version": "v2.14.2",
                    "actor": "alice@opsdeck.dev",
                    "reason": "Testing tampered state"
                }))
                .with_request_state("rs1.tampered.sig"),
        )
        .await
        .expect_err("tampered requestState must be rejected");
    match tampered_err {
        ServiceError::McpError(data) => assert_eq!(data.code, ErrorCode::INVALID_PARAMS),
        other => panic!("unexpected error variant: {other:?}"),
    }

    // Async task spawn + cooperative cancel over stateless 2026-07-28 HTTP
    let task_resp = client
        .call_tool_once(
            CallToolRequestParams::new("run_diagnostic_probe")
                .with_arguments(rmcp::object!({
                    "service_name": "checkout-api",
                    "stage_delay_ms": 500
                })),
        )
        .await?;

    let task_id = match task_resp {
        CallToolResponse::Task(created) => {
            assert_eq!(created.task.status, TaskStatus::Working);
            created.task.task_id
        }
        other => panic!("expected Task response, got {other:?}"),
    };

    client
        .peer()
        .cancel_task(CancelTaskParams::new(task_id.clone()))
        .await?;

    let mut settled_status = TaskStatus::Working;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        let info = client
            .peer()
            .get_task(GetTaskParams::new(task_id.clone()))
            .await?;
        if info.task.status().is_terminal() {
            settled_status = info.task.status();
            break;
        }
    }
    assert_eq!(settled_status, TaskStatus::Cancelled);

    client.cancel().await?;
    let _ = shutdown_tx.send(());
    server_task.await??;
    Ok(())
}

#[tokio::test]
#[ignore = "requires running Postgres (`pnpm infra:up`)"]
async fn live_postgres_mrtr_elicitation_and_task_completion() -> anyhow::Result<()> {
    let store = OpsStore::connect(&test_database_url()).await?;
    let server = OpsServer::with_secret(store, TEST_STATE_SECRET)?;

    let (server_io, client_io) = tokio::io::duplex(64 * 1024);
    let (server_read, server_write) = tokio::io::split(server_io);
    let (client_read, client_write) = tokio::io::split(client_io);

    let server_task = tokio::spawn(async move {
        let running = server.serve((server_read, server_write)).await?;
        running.waiting().await?;
        Ok::<_, anyhow::Error>(())
    });

    let client_config = ClientConfig::new(
        ClientCapabilities::builder().enable_tasks().build(),
        Implementation::from_build_env(),
    );
    let client = client_config
        .serve_with_lifecycle(
            (client_read, client_write),
            ClientLifecycleMode::Discover {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
            },
        )
        .await?;

    let _tools = client.list_all_tools().await?;

    // Round 1 of rollback_deployment returns InputRequiredResult with sealed requestState
    let round1 = client
        .call_tool_once(
            CallToolRequestParams::new("rollback_deployment").with_arguments(rmcp::object!({
                "service_name": "checkout-api",
                "target_version": "v2.14.2",
                "actor": "alice@opsdeck.dev",
                "reason": "Latency spike"
            })),
        )
        .await?;

    let (request_state, input_requests) = match round1 {
        CallToolResponse::InputRequired(req) => (
            req.request_state.expect("requestState issued"),
            req.input_requests.expect("inputRequests issued"),
        ),
        other => panic!("expected InputRequired, got {other:?}"),
    };
    assert!(input_requests.contains_key("confirm_rollback"));

    // Round 2 with action: "decline" returns completed without mutating Postgres
    let mut decline_responses = InputResponses::new();
    decline_responses.insert(
        "confirm_rollback".to_owned(),
        serde_json::json!({ "action": "decline" }),
    );
    let round2 = client
        .call_tool_once(
            CallToolRequestParams::new("rollback_deployment")
                .with_arguments(rmcp::object!({
                    "service_name": "checkout-api",
                    "target_version": "v2.14.2",
                    "actor": "alice@opsdeck.dev",
                    "reason": "Latency spike"
                }))
                .with_request_state(request_state)
                .with_input_responses(decline_responses),
        )
        .await?;

    match round2 {
        CallToolResponse::Complete(res) => {
            assert_ne!(res.is_error, Some(true));
        }
        other => panic!("expected Complete after decline, got {other:?}"),
    }

    // Task completion with live Postgres probe
    let task_resp = client
        .call_tool_once(
            CallToolRequestParams::new("run_diagnostic_probe").with_arguments(rmcp::object!({
                "service_name": "checkout-api",
                "stage_delay_ms": 20
            })),
        )
        .await?;

    let task_id = match task_resp {
        CallToolResponse::Task(created) => created.task.task_id,
        other => panic!("expected Task, got {other:?}"),
    };

    let mut completed = false;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        let info = client
            .peer()
            .get_task(GetTaskParams::new(task_id.clone()))
            .await?;
        if info.task.status() == TaskStatus::Completed {
            completed = true;
            break;
        }
    }
    assert!(completed, "diagnostic probe task must complete against Postgres");

    client.cancel().await?;
    server_task.await??;
    Ok(())
}
