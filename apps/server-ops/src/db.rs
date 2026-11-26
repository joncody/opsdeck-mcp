use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRecord {
    pub id: Uuid,
    pub name: String,
    pub tier: String,
    pub owner_team: String,
    pub repo_url: String,
    pub status: String,
    pub current_version: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentRecord {
    pub id: Uuid,
    pub service_id: Uuid,
    pub service_name: String,
    pub version: String,
    pub environment: String,
    pub status: String,
    pub deployed_by: String,
    pub commit_sha: String,
    pub notes: String,
    pub deployed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct IncidentRecord {
    pub id: Uuid,
    pub service_id: Uuid,
    pub service_name: String,
    pub title: String,
    pub severity: String,
    pub status: String,
    pub summary: String,
    pub commander: String,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RunbookRecord {
    pub id: Uuid,
    pub slug: String,
    pub service_id: Option<Uuid>,
    pub title: String,
    pub category: String,
    pub content_md: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RunbookSummary {
    pub slug: String,
    pub title: String,
    pub category: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDetail {
    pub service: ServiceRecord,
    pub recent_deployments: Vec<DeploymentRecord>,
    pub active_incidents: Vec<IncidentRecord>,
}

#[derive(FromRow)]
struct DiagnosticProbeRow {
    status: Option<String>,
    current_version: Option<String>,
    open_incident_count: i64,
    active_pg_connections: i64,
}

#[derive(Clone)]
pub struct OpsStore {
    pool: PgPool,
}

impl OpsStore {
    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn connect(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub fn connect_lazy(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect_lazy(database_url)?;
        Ok(Self { pool })
    }

    pub async fn list_services(
        &self,
        status: Option<&str>,
    ) -> Result<Vec<ServiceRecord>, sqlx::Error> {
        sqlx::query_as::<_, ServiceRecord>(
            r#"
            SELECT id, name, tier, owner_team, repo_url, status, current_version, updated_at
            FROM services
            WHERE ($1::TEXT IS NULL OR status = $1)
            ORDER BY tier ASC, name ASC
            "#,
        )
        .bind(status)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_service_names(&self) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar::<_, String>("SELECT name FROM services ORDER BY name ASC")
            .fetch_all(&self.pool)
            .await
    }

    pub async fn get_service_detail(
        &self,
        name: &str,
    ) -> Result<Option<ServiceDetail>, sqlx::Error> {
        let service = sqlx::query_as::<_, ServiceRecord>(
            r#"
            SELECT id, name, tier, owner_team, repo_url, status, current_version, updated_at
            FROM services
            WHERE name = $1
            "#,
        )
        .bind(name)
        .fetch_optional(&self.pool)
        .await?;

        let Some(service) = service else {
            return Ok(None);
        };

        let recent_deployments = sqlx::query_as::<_, DeploymentRecord>(
            r#"
            SELECT d.id, d.service_id, s.name AS service_name, d.version, d.environment,
                   d.status, d.deployed_by, d.commit_sha, d.notes, d.deployed_at
            FROM deployments d
            JOIN services s ON s.id = d.service_id
            WHERE d.service_id = $1
            ORDER BY d.deployed_at DESC
            LIMIT 10
            "#,
        )
        .bind(service.id)
        .fetch_all(&self.pool)
        .await?;

        let active_incidents = sqlx::query_as::<_, IncidentRecord>(
            r#"
            SELECT i.id, i.service_id, s.name AS service_name, i.title, i.severity,
                   i.status, i.summary, i.commander, i.created_at, i.resolved_at
            FROM incidents i
            JOIN services s ON s.id = i.service_id
            WHERE i.service_id = $1 AND i.status <> 'resolved'
            ORDER BY i.created_at DESC
            "#,
        )
        .bind(service.id)
        .fetch_all(&self.pool)
        .await?;

        Ok(Some(ServiceDetail {
            service,
            recent_deployments,
            active_incidents,
        }))
    }

    pub async fn list_incidents(
        &self,
        status: Option<&str>,
        severity: Option<&str>,
    ) -> Result<Vec<IncidentRecord>, sqlx::Error> {
        sqlx::query_as::<_, IncidentRecord>(
            r#"
            SELECT i.id, i.service_id, s.name AS service_name, i.title, i.severity,
                   i.status, i.summary, i.commander, i.created_at, i.resolved_at
            FROM incidents i
            JOIN services s ON s.id = i.service_id
            WHERE ($1::TEXT IS NULL OR i.status = $1)
              AND ($2::TEXT IS NULL OR i.severity = $2)
            ORDER BY i.created_at DESC
            "#,
        )
        .bind(status)
        .bind(severity)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_open_incidents(&self) -> Result<Vec<IncidentRecord>, sqlx::Error> {
        sqlx::query_as::<_, IncidentRecord>(
            r#"
            SELECT i.id, i.service_id, s.name AS service_name, i.title, i.severity,
                   i.status, i.summary, i.commander, i.created_at, i.resolved_at
            FROM incidents i
            JOIN services s ON s.id = i.service_id
            WHERE i.status IN ('open', 'mitigating')
            ORDER BY i.created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn get_incident(&self, id: Uuid) -> Result<Option<IncidentRecord>, sqlx::Error> {
        sqlx::query_as::<_, IncidentRecord>(
            r#"
            SELECT i.id, i.service_id, s.name AS service_name, i.title, i.severity,
                   i.status, i.summary, i.commander, i.created_at, i.resolved_at
            FROM incidents i
            JOIN services s ON s.id = i.service_id
            WHERE i.id = $1
            "#,
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn create_incident(
        &self,
        service_name: &str,
        title: &str,
        severity: &str,
        summary: &str,
        commander: &str,
    ) -> Result<Result<IncidentRecord, String>, sqlx::Error> {
        let service_id = sqlx::query_scalar::<_, Uuid>("SELECT id FROM services WHERE name = $1")
            .bind(service_name)
            .fetch_optional(&self.pool)
            .await?;

        let Some(service_id) = service_id else {
            let known = self.list_service_names().await?;
            return Ok(Err(format!(
                "Unknown service '{service_name}'. Available services: {}",
                known.join(", ")
            )));
        };

        let incident_id = Uuid::new_v4();
        let record = sqlx::query_as::<_, IncidentRecord>(
            r#"
            WITH inserted AS (
                INSERT INTO incidents (id, service_id, title, severity, status, summary, commander)
                VALUES ($1, $2, $3, $4, 'open', $5, $6)
                RETURNING id, service_id, title, severity, status, summary, commander, created_at, resolved_at
            )
            SELECT inserted.id, inserted.service_id, $7::TEXT AS service_name, inserted.title,
                   inserted.severity, inserted.status, inserted.summary, inserted.commander,
                   inserted.created_at, inserted.resolved_at
            FROM inserted
            "#,
        )
        .bind(incident_id)
        .bind(service_id)
        .bind(title)
        .bind(severity)
        .bind(summary)
        .bind(commander)
        .bind(service_name)
        .fetch_one(&self.pool)
        .await?;

        Ok(Ok(record))
    }

    pub async fn update_incident_status(
        &self,
        id: Uuid,
        status: &str,
    ) -> Result<Option<IncidentRecord>, sqlx::Error> {
        sqlx::query_as::<_, IncidentRecord>(
            r#"
            WITH updated AS (
                UPDATE incidents
                SET status = $2,
                    resolved_at = CASE WHEN $2 = 'resolved' THEN COALESCE(resolved_at, NOW()) ELSE NULL END
                WHERE id = $1
                RETURNING id, service_id, title, severity, status, summary, commander, created_at, resolved_at
            )
            SELECT u.id, u.service_id, s.name AS service_name, u.title, u.severity,
                   u.status, u.summary, u.commander, u.created_at, u.resolved_at
            FROM updated u
            JOIN services s ON s.id = u.service_id
            "#,
        )
        .bind(id)
        .bind(status)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn list_deployments(
        &self,
        service_name: Option<&str>,
        limit: i64,
    ) -> Result<Vec<DeploymentRecord>, sqlx::Error> {
        sqlx::query_as::<_, DeploymentRecord>(
            r#"
            SELECT d.id, d.service_id, s.name AS service_name, d.version, d.environment,
                   d.status, d.deployed_by, d.commit_sha, d.notes, d.deployed_at
            FROM deployments d
            JOIN services s ON s.id = d.service_id
            WHERE ($1::TEXT IS NULL OR s.name = $1)
            ORDER BY d.deployed_at DESC
            LIMIT $2
            "#,
        )
        .bind(service_name)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn list_runbook_summaries(&self) -> Result<Vec<RunbookSummary>, sqlx::Error> {
        sqlx::query_as::<_, RunbookSummary>(
            r#"
            SELECT slug, title, category, updated_at
            FROM runbooks
            ORDER BY category ASC, slug ASC
            "#,
        )
        .fetch_all(&self.pool)
        .await
    }

    pub async fn get_runbook(&self, slug: &str) -> Result<Option<RunbookRecord>, sqlx::Error> {
        sqlx::query_as::<_, RunbookRecord>(
            r#"
            SELECT id, slug, service_id, title, category, content_md, updated_at
            FROM runbooks
            WHERE slug = $1
            "#,
        )
        .bind(slug)
        .fetch_optional(&self.pool)
        .await
    }

    pub async fn verify_rollback_candidate(
        &self,
        service_name: &str,
        target_version: &str,
    ) -> Result<Result<String, String>, sqlx::Error> {
        let service = sqlx::query_as::<_, ServiceRecord>(
            r#"
            SELECT id, name, tier, owner_team, repo_url, status, current_version, updated_at
            FROM services
            WHERE name = $1
            "#,
        )
        .bind(service_name)
        .fetch_optional(&self.pool)
        .await?;

        let Some(service) = service else {
            let known = self.list_service_names().await?;
            return Ok(Err(format!(
                "Unknown service '{service_name}'. Available services: {}",
                known.join(", ")
            )));
        };

        if service.current_version == target_version {
            return Ok(Err(format!(
                "Service '{service_name}' is already running '{target_version}'. Choose an earlier deployment version."
            )));
        }

        let exists = sqlx::query_scalar::<_, Uuid>(
            r#"
            SELECT id
            FROM deployments
            WHERE service_id = $1 AND version = $2 AND environment = 'production'
            LIMIT 1
            "#,
        )
        .bind(service.id)
        .bind(target_version)
        .fetch_optional(&self.pool)
        .await?;

        if exists.is_none() {
            let known_versions = sqlx::query_scalar::<_, String>(
                r#"
                SELECT DISTINCT version
                FROM deployments
                WHERE service_id = $1 AND environment = 'production'
                ORDER BY version DESC
                "#,
            )
            .bind(service.id)
            .fetch_all(&self.pool)
            .await?;
            return Ok(Err(format!(
                "No production deployment found for '{service_name}' at version '{target_version}'. Known versions: {}",
                known_versions.join(", ")
            )));
        }

        Ok(Ok(service.current_version))
    }

    pub async fn rollback_deployment(
        &self,
        service_name: &str,
        target_version: &str,
        actor: &str,
        reason: &str,
    ) -> Result<Result<DeploymentRecord, String>, sqlx::Error> {
        let mut tx = self.pool.begin().await?;

        let service = sqlx::query_as::<_, ServiceRecord>(
            r#"
            SELECT id, name, tier, owner_team, repo_url, status, current_version, updated_at
            FROM services
            WHERE name = $1
            FOR UPDATE
            "#,
        )
        .bind(service_name)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(service) = service else {
            tx.rollback().await?;
            let known = self.list_service_names().await?;
            return Ok(Err(format!(
                "Unknown service '{service_name}'. Available services: {}",
                known.join(", ")
            )));
        };

        if service.current_version == target_version {
            tx.rollback().await?;
            return Ok(Err(format!(
                "Service '{service_name}' is already running '{target_version}'. Choose an earlier deployment version."
            )));
        }

        let target_commit = sqlx::query_scalar::<_, String>(
            r#"
            SELECT commit_sha
            FROM deployments
            WHERE service_id = $1 AND version = $2 AND environment = 'production'
            ORDER BY deployed_at DESC
            LIMIT 1
            "#,
        )
        .bind(service.id)
        .bind(target_version)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(target_commit) = target_commit else {
            tx.rollback().await?;
            let known_versions = sqlx::query_scalar::<_, String>(
                r#"
                SELECT DISTINCT version
                FROM deployments
                WHERE service_id = $1 AND environment = 'production'
                ORDER BY version DESC
                "#,
            )
            .bind(service.id)
            .fetch_all(&self.pool)
            .await?;
            return Ok(Err(format!(
                "No production deployment found for '{service_name}' at version '{target_version}'. Known versions: {}",
                known_versions.join(", ")
            )));
        };

        sqlx::query(
            r#"
            UPDATE deployments
            SET status = 'rolled_back'
            WHERE service_id = $1 AND environment = 'production' AND status = 'active'
            "#,
        )
        .bind(service.id)
        .execute(&mut *tx)
        .await?;

        let deployment_id = Uuid::new_v4();
        let notes = format!("Rollback from {}: {reason}", service.current_version);
        let inserted = sqlx::query_as::<_, DeploymentRecord>(
            r#"
            WITH inserted AS (
                INSERT INTO deployments (id, service_id, version, environment, status, deployed_by, commit_sha, notes)
                VALUES ($1, $2, $3, 'production', 'active', $4, $5, $6)
                RETURNING id, service_id, version, environment, status, deployed_by, commit_sha, notes, deployed_at
            )
            SELECT inserted.id, inserted.service_id, $7::TEXT AS service_name, inserted.version,
                   inserted.environment, inserted.status, inserted.deployed_by, inserted.commit_sha,
                   inserted.notes, inserted.deployed_at
            FROM inserted
            "#,
        )
        .bind(deployment_id)
        .bind(service.id)
        .bind(target_version)
        .bind(actor)
        .bind(target_commit)
        .bind(notes)
        .bind(service_name)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            UPDATE services
            SET current_version = $2,
                status = 'healthy',
                updated_at = NOW()
            WHERE id = $1
            "#,
        )
        .bind(service.id)
        .bind(target_version)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(Ok(inserted))
    }

    pub async fn run_diagnostic_probe(&self, service_name: &str) -> Result<Value, sqlx::Error> {
        let row = sqlx::query_as::<_, DiagnosticProbeRow>(
            r#"
            SELECT
                s.status,
                s.current_version,
                COALESCE(
                    (SELECT COUNT(*)::BIGINT
                     FROM incidents i
                     WHERE i.service_id = s.id AND i.status <> 'resolved'),
                    0
                ) AS open_incident_count,
                (SELECT COUNT(*)::BIGINT
                 FROM pg_stat_activity
                 WHERE datname = current_database()) AS active_pg_connections
            FROM (SELECT $1::TEXT AS target_name) q
            LEFT JOIN services s ON s.name = q.target_name
            "#,
        )
        .bind(service_name)
        .fetch_one(&self.pool)
        .await?;

        Ok(json!({
            "serviceName": service_name,
            "serviceFound": row.status.is_some(),
            "currentStatus": row.status,
            "currentVersion": row.current_version,
            "openIncidentCount": row.open_incident_count,
            "activePgConnections": row.active_pg_connections,
            "checkedAt": Utc::now(),
        }))
    }
}
