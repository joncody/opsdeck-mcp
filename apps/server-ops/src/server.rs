use std::{sync::Arc, time::Duration};

use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    handler::server::{
        router::{prompt::PromptRouter, tool::ToolRouter},
        tool::{InputResponses, RequestState},
        wrapper::Parameters,
    },
    model::{
        CallToolResponse, CallToolResult, CancelTaskParams, ContentBlock, CreateTaskResult,
        ElicitResult, ElicitationAction, ErrorCode, GetPromptResult, GetTaskParams, GetTaskResult,
        Implementation, InputRequest, InputRequests, InputRequiredResult,
        ListResourceTemplatesResult, ListResourcesResult, PaginatedRequestParams, PromptMessage,
        ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, RequestStateCodec,
        Resource, ResourceContents, ResourceTemplate, Role, SealOptions, ServerCapabilities,
        ServerConfig,
    },
    prompt, prompt_handler, prompt_router,
    service::RequestContext,
    task_manager::{TaskExit, TaskManager, TaskOptions},
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::{AuthClaims, SCOPE_DEPLOY_ROLLBACK, SCOPE_INCIDENT_WRITE, SCOPE_READ},
    db::OpsStore,
};

const ALLOWED_SERVICE_STATUSES: [&str; 3] = ["healthy", "degraded", "down"];
const ALLOWED_INCIDENT_STATUSES: [&str; 3] = ["open", "mitigating", "resolved"];
const ALLOWED_SEVERITIES: [&str; 4] = ["sev1", "sev2", "sev3", "sev4"];
const ROLLBACK_INPUT_KEY: &str = "confirm_rollback";
const ROLLBACK_STATE_TTL_SECS: u64 = 300;
const INSUFFICIENT_SCOPE_CODE: ErrorCode = ErrorCode(-32003);

const SERVER_INSTRUCTIONS: &str = "\
OpsDeck MCP operations server. Inspect services, deployments, incidents, and runbooks.\n\
Prefer reading `ops://services/{name}` or `ops://runbooks/{slug}` before mutating production state.\n\
`rollback_deployment` requires human confirmation via 2026-07-28 InputRequired elicitation.";

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListServicesArgs {
    #[schemars(description = "Optional filter: healthy, degraded, or down")]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ServiceDetailArgs {
    #[schemars(
        description = "Unique service name (for example checkout-api)",
        extend("x-mcp-header" = "Service")
    )]
    pub service_name: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListIncidentsArgs {
    #[schemars(description = "Optional status filter: open, mitigating, or resolved")]
    pub status: Option<String>,
    #[schemars(description = "Optional severity filter: sev1, sev2, sev3, or sev4")]
    pub severity: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct CreateIncidentArgs {
    #[schemars(
        description = "Target service name",
        extend("x-mcp-header" = "Service")
    )]
    pub service_name: String,
    #[schemars(description = "Short incident headline")]
    pub title: String,
    #[schemars(description = "Severity level: sev1, sev2, sev3, or sev4")]
    pub severity: String,
    #[schemars(description = "Impact and observed symptoms")]
    pub summary: String,
    #[schemars(description = "On-call commander email or handle")]
    pub commander: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct UpdateIncidentStatusArgs {
    #[schemars(description = "Incident UUID")]
    pub incident_id: String,
    #[schemars(description = "New status: open, mitigating, or resolved")]
    pub status: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ListDeploymentsArgs {
    #[schemars(description = "Optional service name filter")]
    pub service_name: Option<String>,
    #[schemars(description = "Maximum rows to return (1..=50, default 10)")]
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RollbackDeploymentArgs {
    #[schemars(
        description = "Service to roll back",
        extend("x-mcp-header" = "Service")
    )]
    pub service_name: String,
    #[schemars(description = "Previously deployed production version (for example v2.14.2)")]
    pub target_version: String,
    #[schemars(description = "Operator requesting the rollback")]
    pub actor: String,
    #[schemars(description = "Audit reason linking to incident or regression")]
    pub reason: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DiagnosticProbeArgs {
    #[schemars(
        description = "Service name to probe (for example checkout-api)",
        extend("x-mcp-header" = "Service")
    )]
    pub service_name: String,
    #[schemars(description = "Optional delay per stage in ms (default 350, range 10..=2000)")]
    pub stage_delay_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RollbackStatePayload {
    service_name: String,
    target_version: String,
    from_version: String,
    actor: String,
    reason: String,
}

#[derive(Debug, Deserialize)]
struct RollbackConfirmationForm {
    confirmed: Option<bool>,
    ticket_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct TriageIncidentPromptArgs {
    #[schemars(description = "Incident UUID to triage")]
    pub incident_id: String,
    #[schemars(description = "Optional focus area such as database, deploy, or auth")]
    pub focus: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct PostmortemDraftPromptArgs {
    #[schemars(description = "Incident UUID for the postmortem")]
    pub incident_id: String,
    #[schemars(description = "Optional target audience (engineering, executive)")]
    pub audience: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ReleaseReadinessPromptArgs {
    #[schemars(description = "Service name to audit prior to release")]
    pub service_name: String,
}

fn require_scope(
    context: &RequestContext<RoleServer>,
    required_scope: &str,
) -> Result<(), McpError> {
    // Only HTTP requests carry axum::http::request::Parts; local stdio runs as trusted local operator.
    let Some(parts) = context.extensions.get::<axum::http::request::Parts>() else {
        return Ok(());
    };

    let Some(claims) = parts.extensions.get::<AuthClaims>() else {
        return Err(McpError::new(
            INSUFFICIENT_SCOPE_CODE,
            "Missing authenticated OAuth 2.1 claims on HTTP request",
            Some(json!({ "requiredScope": required_scope })),
        ));
    };

    if claims.has_scope(required_scope) {
        return Ok(());
    }

    Err(McpError::new(
        INSUFFICIENT_SCOPE_CODE,
        format!("Insufficient OAuth scope: '{required_scope}' required"),
        Some(json!({
            "error": "insufficient_scope",
            "requiredScope": required_scope,
            "grantedScopes": claims.scope,
        })),
    ))
}

fn validate_allowed(value: &str, allowed: &[&str], field: &str) -> Result<(), CallToolResult> {
    if allowed.contains(&value) {
        return Ok(());
    }
    Err(CallToolResult::error(vec![ContentBlock::text(format!(
        "Invalid {field} '{value}'. Allowed values: {}. Retry with one of those exact values.",
        allowed.join(", ")
    ))]))
}

fn json_tool_result<T: Serialize>(value: &T) -> Result<CallToolResult, McpError> {
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|err| McpError::internal_error(err.to_string(), None))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(
        serialized,
    )]))
}

fn db_tool_error(context: &str, err: sqlx::Error) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(format!(
        "{context}: database error ({err}). Verify Postgres is running and retry."
    ))])
}

fn text_resource_response(uri: &str, body: String, mime_type: &str) -> ReadResourceResponse {
    ReadResourceResult::new(vec![
        ResourceContents::text(body, uri).with_mime_type(mime_type),
    ])
    .into()
}

fn json_resource_response<T: Serialize>(
    uri: &str,
    value: &T,
) -> Result<ReadResourceResponse, McpError> {
    let body = serde_json::to_string_pretty(value)
        .map_err(|err| McpError::internal_error(err.to_string(), None))?;
    Ok(text_resource_response(uri, body, "application/json"))
}

fn make_resource(uri: &str, name: &str, description: &str, mime_type: &str) -> Resource {
    let mut resource = Resource::new(uri, name);
    resource.description = Some(description.to_owned());
    resource.mime_type = Some(mime_type.to_owned());
    resource
}

fn make_resource_template(
    uri_template: &str,
    name: &str,
    description: &str,
    mime_type: &str,
) -> ResourceTemplate {
    let mut template = ResourceTemplate::new(uri_template, name);
    template.description = Some(description.to_owned());
    template.mime_type = Some(mime_type.to_owned());
    template
}

fn rollback_binding_bytes(service_name: &str, target_version: &str) -> Vec<u8> {
    format!("rollback_deployment:{service_name}:{target_version}").into_bytes()
}

fn build_rollback_elicitation_result(
    sealed_state: String,
    service_name: &str,
    from_version: &str,
    target_version: &str,
    reason: &str,
) -> Result<InputRequiredResult, McpError> {
    let request: InputRequest = serde_json::from_value(json!({
        "method": "elicitation/create",
        "params": {
            "message": format!(
                "Approve production rollback of `{service_name}` from `{from_version}` to `{target_version}`? Reason: {reason}"
            ),
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "confirmed": {
                        "type": "boolean",
                        "title": "Confirm Production Rollback",
                        "description": "Check to authorize updating production deployment state",
                        "default": false
                    },
                    "ticket_id": {
                        "type": "string",
                        "title": "Incident or Change Ticket",
                        "description": "Audit ticket reference (for example INC-3301)",
                        "minLength": 3,
                        "default": "INC-3301"
                    }
                },
                "required": ["confirmed", "ticket_id"]
            }
        }
    }))
    .map_err(|err| McpError::internal_error(err.to_string(), None))?;

    let mut requests = InputRequests::new();
    requests.insert(ROLLBACK_INPUT_KEY.to_owned(), request);
    Ok(InputRequiredResult::new(Some(requests), Some(sealed_state)))
}

#[derive(Clone)]
pub struct OpsServer {
    store: OpsStore,
    state_codec: Arc<RequestStateCodec>,
    tasks: TaskManager,
    tool_router: ToolRouter<Self>,
    prompt_router: PromptRouter<Self>,
}

impl OpsServer {
    pub fn with_secret(store: OpsStore, secret: &[u8]) -> anyhow::Result<Self> {
        let codec = RequestStateCodec::try_new(secret)
            .map_err(|err| anyhow::anyhow!("invalid request-state secret: {err}"))?;
        Ok(Self {
            store,
            state_codec: Arc::new(codec),
            tasks: TaskManager::new(),
            tool_router: Self::tool_router(),
            prompt_router: Self::prompt_router(),
        })
    }
}

#[tool_router]
impl OpsServer {
    #[tool(
        description = "List monitored services, optionally filtered by status (healthy, degraded, down)."
    )]
    async fn list_services(
        &self,
        Parameters(args): Parameters<ListServicesArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        require_scope(&context, SCOPE_READ)?;

        if let Some(ref status) = args.status
            && let Err(err_result) = validate_allowed(status, &ALLOWED_SERVICE_STATUSES, "status")
        {
            return Ok(err_result);
        }

        match self.store.list_services(args.status.as_deref()).await {
            Ok(services) => json_tool_result(&services),
            Err(err) => Ok(db_tool_error("Failed to list services", err)),
        }
    }

    #[tool(
        description = "Fetch a service along with its recent production deployments and active incidents."
    )]
    async fn get_service_detail(
        &self,
        Parameters(args): Parameters<ServiceDetailArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        require_scope(&context, SCOPE_READ)?;

        if args.service_name.trim().is_empty() {
            return Err(McpError::invalid_params(
                "service_name must be non-empty",
                None,
            ));
        }

        match self
            .store
            .get_service_detail(args.service_name.trim())
            .await
        {
            Ok(Some(detail)) => json_tool_result(&detail),
            Ok(None) => {
                let known = self.store.list_service_names().await.unwrap_or_default();
                Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                    "Service '{}' not found. Available services: {}. You can also read `ops://services`.",
                    args.service_name,
                    known.join(", ")
                ))]))
            }
            Err(err) => Ok(db_tool_error("Failed to fetch service detail", err)),
        }
    }

    #[tool(
        description = "List operational incidents, optionally filtered by status and/or severity."
    )]
    async fn list_incidents(
        &self,
        Parameters(args): Parameters<ListIncidentsArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        require_scope(&context, SCOPE_READ)?;

        if let Some(ref status) = args.status
            && let Err(err_result) = validate_allowed(status, &ALLOWED_INCIDENT_STATUSES, "status")
        {
            return Ok(err_result);
        }
        if let Some(ref severity) = args.severity
            && let Err(err_result) = validate_allowed(severity, &ALLOWED_SEVERITIES, "severity")
        {
            return Ok(err_result);
        }

        match self
            .store
            .list_incidents(args.status.as_deref(), args.severity.as_deref())
            .await
        {
            Ok(incidents) => json_tool_result(&incidents),
            Err(err) => Ok(db_tool_error("Failed to list incidents", err)),
        }
    }

    #[tool(description = "Create a new incident linked to an existing service.")]
    async fn create_incident(
        &self,
        Parameters(args): Parameters<CreateIncidentArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        require_scope(&context, SCOPE_INCIDENT_WRITE)?;

        if args.service_name.trim().is_empty()
            || args.title.trim().is_empty()
            || args.summary.trim().is_empty()
            || args.commander.trim().is_empty()
        {
            return Err(McpError::invalid_params(
                "service_name, title, summary, and commander must all be non-empty",
                None,
            ));
        }

        if let Err(err_result) = validate_allowed(&args.severity, &ALLOWED_SEVERITIES, "severity") {
            return Ok(err_result);
        }

        match self
            .store
            .create_incident(
                args.service_name.trim(),
                args.title.trim(),
                &args.severity,
                args.summary.trim(),
                args.commander.trim(),
            )
            .await
        {
            Ok(Ok(record)) => json_tool_result(&record),
            Ok(Err(domain_msg)) => Ok(CallToolResult::error(vec![ContentBlock::text(domain_msg)])),
            Err(err) => Ok(db_tool_error("Failed to create incident", err)),
        }
    }

    #[tool(description = "Update an incident status to open, mitigating, or resolved.")]
    async fn update_incident_status(
        &self,
        Parameters(args): Parameters<UpdateIncidentStatusArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        require_scope(&context, SCOPE_INCIDENT_WRITE)?;

        let Ok(incident_id) = Uuid::parse_str(args.incident_id.trim()) else {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Invalid incident_id '{}' (expected UUID). List valid IDs with `list_incidents` or `ops://incidents/open`.",
                args.incident_id
            ))]));
        };

        if let Err(err_result) =
            validate_allowed(&args.status, &ALLOWED_INCIDENT_STATUSES, "status")
        {
            return Ok(err_result);
        }

        match self
            .store
            .update_incident_status(incident_id, &args.status)
            .await
        {
            Ok(Some(updated)) => json_tool_result(&updated),
            Ok(None) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "Incident '{incident_id}' was not found. Call `list_incidents` to verify the ID."
            ))])),
            Err(err) => Ok(db_tool_error("Failed to update incident", err)),
        }
    }

    #[tool(description = "List recent deployments, optionally filtered by service_name.")]
    async fn list_deployments(
        &self,
        Parameters(args): Parameters<ListDeploymentsArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        require_scope(&context, SCOPE_READ)?;

        let limit = args.limit.unwrap_or(10);
        if !(1..=50).contains(&limit) {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                "Parameter `limit` must be between 1 and 50.".to_owned(),
            )]));
        }

        match self
            .store
            .list_deployments(args.service_name.as_deref().map(str::trim), limit)
            .await
        {
            Ok(deployments) => json_tool_result(&deployments),
            Err(err) => Ok(db_tool_error("Failed to list deployments", err)),
        }
    }

    #[allow(unused_variables)]
    #[tool(
        description = "Roll back a service in production after explicit human confirmation via 2026-07-28 InputRequired elicitation."
    )]
    async fn rollback_deployment(
        &self,
        Parameters(args): Parameters<RollbackDeploymentArgs>,
        RequestState(request_state): RequestState,
        InputResponses(input_responses): InputResponses,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        require_scope(&context, SCOPE_DEPLOY_ROLLBACK)?;

        let service_name = args.service_name.trim();
        let target_version = args.target_version.trim();
        let actor = args.actor.trim();
        let reason = args.reason.trim();

        if service_name.is_empty()
            || target_version.is_empty()
            || actor.is_empty()
            || reason.is_empty()
        {
            return Err(McpError::invalid_params(
                "service_name, target_version, actor, and reason must all be non-empty",
                None,
            ));
        }

        let binding = rollback_binding_bytes(service_name, target_version);

        let Some(sealed) = request_state else {
            let from_version = match self
                .store
                .verify_rollback_candidate(service_name, target_version)
                .await
            {
                Ok(Ok(version)) => version,
                Ok(Err(domain_msg)) => {
                    return Ok(CallToolResult::error(vec![ContentBlock::text(domain_msg)]).into());
                }
                Err(err) => {
                    return Ok(db_tool_error("Failed to verify rollback target", err).into());
                }
            };

            let state_bytes = serde_json::to_vec(&RollbackStatePayload {
                service_name: service_name.to_owned(),
                target_version: target_version.to_owned(),
                from_version: from_version.clone(),
                actor: actor.to_owned(),
                reason: reason.to_owned(),
            })
            .map_err(|err| McpError::internal_error(err.to_string(), None))?;

            let sealed = self.state_codec.seal_with(
                &state_bytes,
                &SealOptions::new()
                    .associated_data(&binding)
                    .ttl(Duration::from_secs(ROLLBACK_STATE_TTL_SECS)),
            );

            let input_required = build_rollback_elicitation_result(
                sealed,
                service_name,
                &from_version,
                target_version,
                reason,
            )?;
            return Ok(input_required.into());
        };

        let opened_bytes = self.state_codec.open_with(&sealed, &binding).map_err(|_| {
            McpError::invalid_params("Invalid, expired, or tampered requestState", None)
        })?;
        let state: RollbackStatePayload = serde_json::from_slice(&opened_bytes)
            .map_err(|_| McpError::invalid_params("Malformed requestState payload", None))?;

        let raw_response = input_responses
            .as_ref()
            .and_then(|map| map.get(ROLLBACK_INPUT_KEY))
            .cloned();

        let Some(raw_response) = raw_response else {
            let input_required = build_rollback_elicitation_result(
                sealed,
                &state.service_name,
                &state.from_version,
                &state.target_version,
                &state.reason,
            )?;
            return Ok(input_required.into());
        };

        let elicit_result: ElicitResult = serde_json::from_value(raw_response).map_err(|err| {
            McpError::invalid_params(format!("Invalid elicitation response: {err}"), None)
        })?;

        match elicit_result.action {
            ElicitationAction::Decline | ElicitationAction::Cancel => {
                return json_tool_result(&json!({
                    "executed": false,
                    "status": "cancelled_by_operator",
                    "serviceName": state.service_name,
                    "targetVersion": state.target_version,
                }))
                .map(CallToolResponse::from);
            }
            ElicitationAction::Accept => {}
            other => {
                return Err(McpError::invalid_params(
                    format!("Unsupported elicitation action: {other:?}"),
                    None,
                ));
            }
        }

        let form: RollbackConfirmationForm = elicit_result
            .content
            .map(serde_json::from_value)
            .transpose()
            .map_err(|err| {
                McpError::invalid_params(format!("Invalid confirmation form: {err}"), None)
            })?
            .unwrap_or(RollbackConfirmationForm {
                confirmed: Some(false),
                ticket_id: None,
            });

        if form.confirmed != Some(true) {
            return json_tool_result(&json!({
                "executed": false,
                "status": "confirmation_unchecked",
                "serviceName": state.service_name,
                "targetVersion": state.target_version,
            }))
            .map(CallToolResponse::from);
        }

        let ticket_id = form.ticket_id.unwrap_or_default().trim().to_owned();
        if ticket_id.len() < 3 {
            let input_required = build_rollback_elicitation_result(
                sealed,
                &state.service_name,
                &state.from_version,
                &state.target_version,
                &state.reason,
            )?;
            return Ok(input_required.into());
        }

        let audit_reason = format!("[{ticket_id}] {}", state.reason);
        match self
            .store
            .rollback_deployment(
                &state.service_name,
                &state.target_version,
                &state.actor,
                &audit_reason,
            )
            .await
        {
            Ok(Ok(deployment)) => json_tool_result(&json!({
                "executed": true,
                "ticketId": ticket_id,
                "deployment": deployment,
            }))
            .map(CallToolResponse::from),
            Ok(Err(domain_msg)) => {
                Ok(CallToolResult::error(vec![ContentBlock::text(domain_msg)]).into())
            }
            Err(err) => Ok(db_tool_error("Failed to execute rollback", err).into()),
        }
    }

    #[tool(
        description = "Run a multi-stage PostgreSQL & service health diagnostic probe (materialized as an async Task when client declares io.modelcontextprotocol/tasks)."
    )]
    async fn run_diagnostic_probe(
        &self,
        Parameters(args): Parameters<DiagnosticProbeArgs>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        require_scope(&context, SCOPE_READ)?;

        let service_name = args.service_name.trim().to_owned();
        if service_name.is_empty() {
            return Err(McpError::invalid_params(
                "service_name must be non-empty",
                None,
            ));
        }

        let delay_ms = args.stage_delay_ms.unwrap_or(350);
        if !(10..=2000).contains(&delay_ms) {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                "stage_delay_ms must be between 10 and 2000.".to_owned(),
            )])
            .into());
        }

        let supports_tasks = context
            .client_capabilities()
            .is_some_and(|caps| caps.supports_tasks());

        if !supports_tasks {
            return match self.store.run_diagnostic_probe(&service_name).await {
                Ok(report) => json_tool_result(&report).map(CallToolResponse::from),
                Err(err) => Ok(db_tool_error("Diagnostic probe failed", err).into()),
            };
        }

        let store = self.store.clone();
        let options = TaskOptions::new()
            .with_poll_interval_ms(300)
            .with_status_message(format!("Queued diagnostic probe for {service_name}"));

        let task = self.tasks.spawn(options, move |task_ctx| {
            Box::pin(async move {
                let stages = [
                    "1/4 Checking PostgreSQL pool activity",
                    "2/4 Inspecting active SEV1/SEV2 incidents",
                    "3/4 Correlating latest production deployments",
                    "4/4 Finalizing diagnostic report",
                ];

                for stage in stages {
                    task_ctx.set_status_message(stage);
                    tokio::select! {
                        () = task_ctx.cancelled() => return Err(TaskExit::Cancelled),
                        () = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                    }
                    if task_ctx.is_cancel_requested() {
                        return Err(TaskExit::Cancelled);
                    }
                }

                let report = store
                    .run_diagnostic_probe(&service_name)
                    .await
                    .map_err(|err| {
                        TaskExit::Error(McpError::internal_error(err.to_string(), None))
                    })?;

                let result = json_tool_result(&report).map_err(TaskExit::Error)?;
                Ok(result)
            })
        });

        Ok(CallToolResponse::Task(CreateTaskResult::new(task)))
    }
}

#[prompt_router]
impl OpsServer {
    #[prompt(
        name = "triage_incident",
        description = "Structured incident triage workflow correlating deployments, service health, and runbooks"
    )]
    async fn triage_incident(
        &self,
        Parameters(args): Parameters<TriageIncidentPromptArgs>,
    ) -> Result<GetPromptResult, McpError> {
        let focus = args.focus.as_deref().unwrap_or("all subsystems");
        let text = format!(
            "Triage incident `{}` with focus on `{focus}`:\n\
            1. Read resource `ops://incidents/{}` to inspect severity, commander, and timeline.\n\
            2. Call `get_service_detail` for the affected service to correlate recent deployments.\n\
            3. Read `ops://runbooks` and load the matching `ops://runbooks/{{slug}}` procedure.\n\
            4. Recommend either safe mitigation (with target rollback version if deploy-correlated) or escalation.",
            args.incident_id, args.incident_id
        );
        Ok(
            GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)])
                .with_description(format!("Incident triage plan for {}", args.incident_id)),
        )
    }

    #[prompt(
        name = "postmortem_draft",
        description = "Generate a blameless postmortem outline from incident and deployment records"
    )]
    async fn postmortem_draft(
        &self,
        Parameters(args): Parameters<PostmortemDraftPromptArgs>,
    ) -> Result<GetPromptResult, McpError> {
        let audience = args.audience.as_deref().unwrap_or("engineering");
        let text = format!(
            "Draft a blameless postmortem for incident `{}` tailored for `{audience}`:\n\
            1. Load `ops://incidents/{}` and `list_deployments` around the incident window.\n\
            2. Structure sections: Impact Summary, Root Cause, Timeline (UTC), Detection & Mitigation, Action Items.\n\
            3. Cite exact deployment commit SHAs and runbook slugs referenced.",
            args.incident_id, args.incident_id
        );
        Ok(
            GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)])
                .with_description(format!("Blameless postmortem draft ({audience})")),
        )
    }

    #[prompt(
        name = "release_readiness",
        description = "Pre-deployment health and open-incident gate check for a service"
    )]
    async fn release_readiness(
        &self,
        Parameters(args): Parameters<ReleaseReadinessPromptArgs>,
    ) -> Result<GetPromptResult, McpError> {
        let text = format!(
            "Evaluate production release readiness for `{}`:\n\
            1. Read `ops://services/{}`.\n\
            2. Verify service status is `healthy` and zero `sev1`/`sev2` incidents are `open` or `mitigating`.\n\
            3. Review the last 5 production deployments via `list_deployments` and output GO / NO-GO with evidence.",
            args.service_name, args.service_name
        );
        Ok(
            GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)])
                .with_description(format!("Release readiness audit for {}", args.service_name)),
        )
    }
}

#[tool_handler(router = self.tool_router)]
#[prompt_handler(router = self.prompt_router)]
impl ServerHandler for OpsServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_prompts()
                .enable_tasks()
                .build(),
        )
        .with_server_info(Implementation::from_build_env())
        .with_instructions(SERVER_INSTRUCTIONS)
    }

    async fn get_task(
        &self,
        request: GetTaskParams,
        context: RequestContext<RoleServer>,
    ) -> Result<GetTaskResult, McpError> {
        require_scope(&context, SCOPE_READ)?;
        let detailed = self.tasks.get_task(&request.task_id)?;
        Ok(GetTaskResult::new(detailed))
    }

    async fn cancel_task(
        &self,
        request: CancelTaskParams,
        context: RequestContext<RoleServer>,
    ) -> Result<(), McpError> {
        require_scope(&context, SCOPE_READ)?;
        self.tasks.cancel_task(&request.task_id)
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        Ok(ListResourcesResult::with_all_items(vec![
            make_resource(
                "ops://services",
                "services",
                "All monitored production services and their current versions/health",
                "application/json",
            ),
            make_resource(
                "ops://incidents/open",
                "open-incidents",
                "All currently open or mitigating incidents ordered by recency",
                "application/json",
            ),
            make_resource(
                "ops://runbooks",
                "runbooks",
                "Index of operational runbooks (metadata without full markdown body)",
                "application/json",
            ),
        ]))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        Ok(ListResourceTemplatesResult::with_all_items(vec![
            make_resource_template(
                "ops://services/{name}",
                "service-detail",
                "Detailed service record with recent deployments and active incidents",
                "application/json",
            ),
            make_resource_template(
                "ops://incidents/{id}",
                "incident-detail",
                "Single incident record identified by UUID",
                "application/json",
            ),
            make_resource_template(
                "ops://runbooks/{slug}",
                "runbook-markdown",
                "Markdown operational runbook identified by slug",
                "text/markdown",
            ),
        ]))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        require_scope(&context, SCOPE_READ)?;
        let uri = request.uri.as_str();

        if uri == "ops://services" {
            let services = self
                .store
                .list_services(None)
                .await
                .map_err(|err| McpError::internal_error(err.to_string(), None))?;
            return json_resource_response(uri, &services);
        }

        if uri == "ops://incidents/open" {
            let open = self
                .store
                .list_incidents(Some("open"), None)
                .await
                .map_err(|err| McpError::internal_error(err.to_string(), None))?;
            let mitigating = self
                .store
                .list_incidents(Some("mitigating"), None)
                .await
                .map_err(|err| McpError::internal_error(err.to_string(), None))?;
            let combined: Vec<_> = open.into_iter().chain(mitigating).collect();
            return json_resource_response(uri, &combined);
        }

        if uri == "ops://runbooks" {
            let runbooks = self
                .store
                .list_runbooks()
                .await
                .map_err(|err| McpError::internal_error(err.to_string(), None))?;
            let index: Vec<_> = runbooks
                .into_iter()
                .map(|r| {
                    json!({
                        "slug": r.slug,
                        "title": r.title,
                        "category": r.category,
                        "uri": format!("ops://runbooks/{}", r.slug),
                        "updatedAt": r.updated_at,
                    })
                })
                .collect();
            return json_resource_response(uri, &index);
        }

        if let Some(name) = uri.strip_prefix("ops://services/")
            && !name.is_empty()
            && !name.contains('/')
        {
            let detail = self
                .store
                .get_service_detail(name)
                .await
                .map_err(|err| McpError::internal_error(err.to_string(), None))?;
            let Some(detail) = detail else {
                return Err(McpError::resource_not_found(
                    "service_not_found",
                    Some(json!({ "uri": uri })),
                ));
            };
            return json_resource_response(uri, &detail);
        }

        if let Some(id_str) = uri.strip_prefix("ops://incidents/")
            && !id_str.is_empty()
            && !id_str.contains('/')
        {
            let Ok(id) = Uuid::parse_str(id_str) else {
                return Err(McpError::invalid_params(
                    "incident resource URI id must be a valid UUID",
                    Some(json!({ "uri": uri })),
                ));
            };
            let incident = self
                .store
                .get_incident(id)
                .await
                .map_err(|err| McpError::internal_error(err.to_string(), None))?;
            let Some(incident) = incident else {
                return Err(McpError::resource_not_found(
                    "incident_not_found",
                    Some(json!({ "uri": uri })),
                ));
            };
            return json_resource_response(uri, &incident);
        }

        if let Some(slug) = uri.strip_prefix("ops://runbooks/")
            && !slug.is_empty()
            && !slug.contains('/')
        {
            let runbook = self
                .store
                .get_runbook(slug)
                .await
                .map_err(|err| McpError::internal_error(err.to_string(), None))?;
            let Some(runbook) = runbook else {
                return Err(McpError::resource_not_found(
                    "runbook_not_found",
                    Some(json!({ "uri": uri })),
                ));
            };
            return Ok(text_resource_response(
                uri,
                runbook.content_md,
                "text/markdown",
            ));
        }

        Err(McpError::resource_not_found(
            "resource_not_found",
            Some(json!({ "uri": uri })),
        ))
    }
}
