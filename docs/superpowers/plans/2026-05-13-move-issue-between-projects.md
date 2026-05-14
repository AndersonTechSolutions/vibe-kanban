# Move Issue Between Projects — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `POST /api/issues/:id/move` endpoint and a `Move to project…` action in the Kanban issue panel that lets a user move a single issue to a different project in the same organization, picking the destination status explicitly. Tags carry over by name; comments / assignees / sub-issue links / PR links follow automatically.

**Architecture:** New Rust route + repo method on the cloud SaaS backend (`crates/remote`). The repo method runs everything in one Postgres transaction: validate the destination status, atomically bump the destination project's `issue_counter` and re-compute `simple_id` via a CTE, upsert tags into the destination project, then `UPDATE issues` to switch the FKs. Frontend adds a new action in `packages/web-core/src/shared/actions/index.ts`, references it in the `issueActions` command-bar page, and opens a new `MoveIssueDialog` for project + status selection. After success, the dialog `useNavigate`s to the new URL.

**Tech Stack:** Rust (axum, sqlx, Postgres), TypeScript (React, TanStack React Query + Electric, ts-rs codegen via `cargo run --bin generate_types`).

**Spec:** `docs/superpowers/specs/2026-05-13-move-issue-between-projects-design.md`

---

## File map

| Path | Action | Purpose |
|---|---|---|
| `crates/api-types/src/issue.rs` | Modify | Add `MoveIssueRequest` struct and re-export via existing `pub use` |
| `crates/remote/src/bin/generate_types.rs` | Modify | Add `MoveIssueRequest::decl()` to the codegen list |
| `shared/remote-types.ts` (generated) | Auto-generated | Updated by codegen — committed |
| `crates/remote/src/db/issues.rs` | Modify | Add `validate_move_request` pure helper + `IssueRepository::move_to_project` |
| `crates/remote/src/routes/issues.rs` | Modify | Add `move_issue` handler + register `POST /issues/:id/move` |
| `packages/web-core/src/shared/lib/remoteApi.ts` | Modify | Add `moveIssue` helper that POSTs to the new endpoint |
| `packages/web-core/src/shared/actions/index.ts` | Modify | Add `MoveIssue` action that opens the dialog |
| `packages/web-core/src/shared/command-bar/actions/pages.ts` | Modify | Reference `Actions.MoveIssue` in `issueActions.items` |
| `packages/web-core/src/pages/kanban/MoveIssueDialog.tsx` | Create | New dialog (project picker, status picker, submit) |

---

## Task 1 — Define `MoveIssueRequest` in `api-types`

**Files:**
- Modify: `crates/api-types/src/issue.rs`

- [ ] **Step 1: Append the struct to the end of `issue.rs`**

Find the end of the file (after `ListIssuesResponse`). Add:

```rust
/// Request body for `POST /api/issues/:id/move`.
///
/// `destination_project_id` and `destination_status_id` are both required; the
/// server validates that the status belongs to the destination project, that
/// both projects are in the same organization, and that the user has access
/// to both projects.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct MoveIssueRequest {
    pub destination_project_id: Uuid,
    pub destination_status_id: Uuid,
}
```

- [ ] **Step 2: Verify it builds**

Run:
```
cargo check -p api-types
```
Expected: `Finished` with no errors.

- [ ] **Step 3: Commit**

```
cd /srv/vibe-kanban/source && git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -m "feat(api-types): add MoveIssueRequest" -- crates/api-types/src/issue.rs
```

---

## Task 2 — Register `MoveIssueRequest` for TypeScript codegen

**Files:**
- Modify: `crates/remote/src/bin/generate_types.rs`
- Modify (auto-regenerated): `shared/remote-types.ts`

- [ ] **Step 1: Add the import**

Find the import block at the top of `generate_types.rs` (around lines 10–20) that already includes `UpdateIssueRequest`. Edit the same import statement to also pull in `MoveIssueRequest`. Search for `UpdateIssueRequest` in the file; add `MoveIssueRequest` to the same `use api_types::{...}` line (alphabetical, before `UpdateIssueCommentReactionRequest`).

- [ ] **Step 2: Add the `::decl()` call**

Around line 121 there's a list of `.decl()` calls. Find the line `UpdateIssueRequest::decl(),` and add immediately after it:

```rust
        MoveIssueRequest::decl(),
```

- [ ] **Step 3: Regenerate the TypeScript file**

Run:
```
cd /srv/vibe-kanban/source && cargo run --bin generate_types
```
Expected: writes `shared/remote-types.ts`. Then:
```
grep MoveIssueRequest shared/remote-types.ts
```
Expected: prints at least the type declaration.

- [ ] **Step 4: Commit both files together**

```
cd /srv/vibe-kanban/source && git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -m "feat(api-types): register MoveIssueRequest for ts-rs codegen" -- crates/remote/src/bin/generate_types.rs shared/remote-types.ts
```

---

## Task 3 — TDD a pure same-destination validator

This is the only logic in the move pipeline that's pure (not SQL-shaped) and therefore worth a unit test.

**Files:**
- Modify: `crates/remote/src/db/issues.rs`

- [ ] **Step 1: Write the failing test**

Find the existing `#[cfg(test)] mod tests { ... }` block at the bottom of `crates/remote/src/db/issues.rs` (around line 694). Add the following test inside that module, after the existing `escapes_like_pattern_special_characters` test:

```rust
    #[test]
    fn validate_move_request_rejects_same_destination() {
        let same = uuid::Uuid::new_v4();
        let err = super::validate_move_request(same, same).unwrap_err();
        assert!(matches!(err, super::MoveValidationError::SameDestination));
    }

    #[test]
    fn validate_move_request_accepts_different_projects() {
        let a = uuid::Uuid::new_v4();
        let b = uuid::Uuid::new_v4();
        super::validate_move_request(a, b).expect("should accept different projects");
    }
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run:
```
cd /srv/vibe-kanban/source && cargo test -p remote --lib validate_move_request 2>&1 | tail -20
```
Expected: compile error — `validate_move_request` and `MoveValidationError` don't exist yet.

- [ ] **Step 3: Implement the validator + error type**

Add this **above** the existing `impl IssueRepository {` block in `crates/remote/src/db/issues.rs` (right after the existing `IssueError` enum and the `IssueRepository` struct declaration):

```rust
/// Pure validation errors for `IssueRepository::move_to_project` callers.
/// These are surfaced to the route layer and mapped to specific HTTP status
/// codes; they never indicate a DB failure.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum MoveValidationError {
    #[error("destination must differ from source")]
    SameDestination,
}

/// Pre-flight validation that does not touch the database. Used by the
/// route handler before opening a transaction.
pub fn validate_move_request(
    source_project_id: Uuid,
    destination_project_id: Uuid,
) -> Result<(), MoveValidationError> {
    if source_project_id == destination_project_id {
        return Err(MoveValidationError::SameDestination);
    }
    Ok(())
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run:
```
cd /srv/vibe-kanban/source && cargo test -p remote --lib validate_move_request 2>&1 | tail -20
```
Expected: `test result: ok. 2 passed; 0 failed`.

- [ ] **Step 5: Commit**

```
cd /srv/vibe-kanban/source && git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -m "feat(issues): add pure validate_move_request helper + unit tests" -- crates/remote/src/db/issues.rs
```

---

## Task 4 — Implement `IssueRepository::move_to_project`

The SQL-shaped half of the operation. No unit test — there is no `#[sqlx::test]` harness in this crate today, and adding one is out of scope per the spec.

**Files:**
- Modify: `crates/remote/src/db/issues.rs`

- [ ] **Step 1: Add a domain error variant for "invalid destination status"**

The route handler validates this and returns 400, but the repo also needs to surface the case structurally (so handlers can pattern-match). Find the existing `IssueError` enum (around line 24–34) and append a new variant:

```rust
    #[error("invalid destination status: {0}")]
    InvalidDestinationStatus(Uuid),
    #[error("destination project not found: {0}")]
    DestinationProjectNotFound(Uuid),
```

- [ ] **Step 2: Add the `move_to_project` method**

Inside `impl IssueRepository { ... }`, after the existing `update` method (search for `pub async fn update` to locate it), add the following method:

```rust
    /// Move an issue to a different project within the same organization.
    ///
    /// Performs the entire move in a single transaction:
    /// 1. Validates `destination_status_id` belongs to `destination_project_id`
    ///    and is not hidden.
    /// 2. Atomically bumps the destination project's `issue_counter` and
    ///    composes the new `simple_id` from the org's `issue_prefix`.
    /// 3. Picks `sort_order = COALESCE(MAX(sort_order),0) + 1.0` for the
    ///    destination's status-scoped Kanban column.
    /// 4. Upserts source-project tags into the destination project by name
    ///    (`ON CONFLICT (project_id, name) DO NOTHING` — existing dest color
    ///    wins), then rewrites `issue_tags` to point at destination tag ids.
    /// 5. `UPDATE issues SET project_id, status_id, issue_number, simple_id,
    ///    sort_order, updated_at = NOW() WHERE id = $issue_id` and returns
    ///    the fresh row.
    ///
    /// The route layer is responsible for authz (`ensure_project_access` on
    /// both source and destination) and the same-org / same-destination
    /// pre-flight checks. `find_by_id` is used to fetch the source `Issue`
    /// before this call so the caller has the `old_issue` value needed for
    /// `notify_issue_update_changes`.
    pub async fn move_to_project(
        tx: &mut sqlx::PgConnection,
        issue_id: Uuid,
        destination_project_id: Uuid,
        destination_status_id: Uuid,
    ) -> Result<Issue, IssueError> {
        // 1. Validate destination status belongs to destination project and isn't hidden.
        let status_ok = sqlx::query_scalar!(
            r#"
            SELECT EXISTS (
                SELECT 1 FROM project_statuses
                WHERE id = $1 AND project_id = $2 AND hidden = false
            ) AS "exists!"
            "#,
            destination_status_id,
            destination_project_id,
        )
        .fetch_one(&mut *tx)
        .await?;
        if !status_ok {
            return Err(IssueError::InvalidDestinationStatus(destination_status_id));
        }

        // 2. Atomically bump the destination project's counter and read the org prefix.
        //    A single CTE keeps it atomic — no TOCTOU window between bump and read.
        let bumped = sqlx::query!(
            r#"
            WITH bumped AS (
                UPDATE projects
                SET issue_counter = issue_counter + 1, updated_at = NOW()
                WHERE id = $1
                RETURNING issue_counter, organization_id
            )
            SELECT
                bumped.issue_counter AS "issue_counter!",
                o.issue_prefix       AS "issue_prefix!"
            FROM bumped
            JOIN organizations o ON o.id = bumped.organization_id
            "#,
            destination_project_id,
        )
        .fetch_optional(&mut *tx)
        .await?;
        let bumped = bumped
            .ok_or(IssueError::DestinationProjectNotFound(destination_project_id))?;
        let new_issue_number = bumped.issue_counter;
        let new_simple_id = format!("{}-{}", bumped.issue_prefix, new_issue_number);

        // 3. Compute bottom-of-column sort_order in destination, status-scoped.
        let new_sort_order: f64 = sqlx::query_scalar!(
            r#"
            SELECT COALESCE(MAX(sort_order), 0) + 1.0 AS "next!"
            FROM issues
            WHERE project_id = $1 AND status_id = $2
            "#,
            destination_project_id,
            destination_status_id,
        )
        .fetch_one(&mut *tx)
        .await?;

        // 4. Tag preservation: read source tags, upsert into destination by name,
        //    then rebuild this issue's issue_tags rows to point at destination ids.
        //    ON CONFLICT DO NOTHING means destination's existing tag (and its color)
        //    wins over the source's color.
        let source_tags = sqlx::query!(
            r#"
            SELECT t.name AS "name!", t.color AS "color!"
            FROM tags t
            JOIN issue_tags it ON it.tag_id = t.id
            WHERE it.issue_id = $1
            "#,
            issue_id,
        )
        .fetch_all(&mut *tx)
        .await?;

        // Drop existing issue_tags first so we don't violate (issue_id, tag_id) uniqueness.
        sqlx::query!(
            "DELETE FROM issue_tags WHERE issue_id = $1",
            issue_id,
        )
        .execute(&mut *tx)
        .await?;

        for src in &source_tags {
            // Upsert the tag by name in the destination project. Existing color wins.
            sqlx::query!(
                r#"
                INSERT INTO tags (project_id, name, color)
                VALUES ($1, $2, $3)
                ON CONFLICT (project_id, name) DO NOTHING
                "#,
                destination_project_id,
                src.name,
                src.color,
            )
            .execute(&mut *tx)
            .await?;
            // Read the (now-existing) destination tag id back.
            let dest_tag_id: Uuid = sqlx::query_scalar!(
                r#"
                SELECT id AS "id!: Uuid"
                FROM tags
                WHERE project_id = $1 AND name = $2
                "#,
                destination_project_id,
                src.name,
            )
            .fetch_one(&mut *tx)
            .await?;
            // Re-link issue to destination tag. (issue_id, tag_id) is unique so we
            // can rely on the prior DELETE above to keep this clean.
            sqlx::query!(
                r#"
                INSERT INTO issue_tags (issue_id, tag_id)
                VALUES ($1, $2)
                ON CONFLICT (issue_id, tag_id) DO NOTHING
                "#,
                issue_id,
                dest_tag_id,
            )
            .execute(&mut *tx)
            .await?;
        }

        // 5. Final UPDATE of the issues row, returning the new state.
        let updated = sqlx::query_as!(
            Issue,
            r#"
            UPDATE issues
            SET project_id   = $2,
                status_id    = $3,
                issue_number = $4,
                simple_id    = $5,
                sort_order   = $6,
                updated_at   = NOW()
            WHERE id = $1
            RETURNING
                id                       AS "id!: Uuid",
                project_id               AS "project_id!: Uuid",
                issue_number             AS "issue_number!",
                simple_id                AS "simple_id!",
                status_id                AS "status_id!: Uuid",
                title                    AS "title!",
                description              AS "description?",
                priority                 AS "priority: IssuePriority",
                start_date               AS "start_date?: DateTime<Utc>",
                target_date              AS "target_date?: DateTime<Utc>",
                completed_at             AS "completed_at?: DateTime<Utc>",
                sort_order               AS "sort_order!",
                parent_issue_id          AS "parent_issue_id?: Uuid",
                parent_issue_sort_order  AS "parent_issue_sort_order?",
                extension_metadata       AS "extension_metadata!",
                creator_user_id          AS "creator_user_id?: Uuid",
                created_at               AS "created_at!: DateTime<Utc>",
                updated_at               AS "updated_at!: DateTime<Utc>"
            "#,
            issue_id,
            destination_project_id,
            destination_status_id,
            new_issue_number,
            new_simple_id,
            new_sort_order,
        )
        .fetch_one(&mut *tx)
        .await?;

        Ok(updated)
    }
```

- [ ] **Step 3: Verify the SELECT projection matches `find_by_id`**

Open the existing `find_by_id` method (~line 268) and confirm the column list in the `RETURNING` clause above matches it field-for-field (same casts, same nullability). If `find_by_id` references a column my `RETURNING` omitted, add it.

Run:
```
cd /srv/vibe-kanban/source && diff <(grep -A30 'fn find_by_id' crates/remote/src/db/issues.rs | grep 'AS \"') <(grep -B1 -A30 'fn move_to_project' crates/remote/src/db/issues.rs | grep 'RETURNING' -A30 | grep 'AS \"')
```
Expected: no output (or only whitespace differences). If lines differ, reconcile.

- [ ] **Step 4: Cargo check**

Run:
```
cd /srv/vibe-kanban/source && cargo check -p remote 2>&1 | tail -25
```
Expected: `Finished` with no errors. Warnings allowed.

If sqlx prepared-query offline cache is enabled and complains about missing `.sqlx/query-*.json` files, regenerate it:
```
cd /srv/vibe-kanban/source && cargo sqlx prepare --workspace -- --all-targets 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```
cd /srv/vibe-kanban/source && git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -m "feat(issues): add IssueRepository::move_to_project" -- crates/remote/src/db/issues.rs .sqlx/ 2>/dev/null || git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -m "feat(issues): add IssueRepository::move_to_project" -- crates/remote/src/db/issues.rs
```

(The `.sqlx/` path is included only if sqlx offline mode is in use — the fallback omits it.)

---

## Task 5 — Add the route handler

**Files:**
- Modify: `crates/remote/src/routes/issues.rs`

- [ ] **Step 1: Update the imports block at the top of the file**

Find the existing `use api_types::{ ... };` block. Add `MoveIssueRequest` to the imported names (alphabetical order — between `IssueSortField` and `ListIssuesResponse`):

```rust
use api_types::{
    DeleteResponse, Issue, IssuePriority, IssueSortField, ListIssuesResponse,
    MoveIssueRequest, MutationResponse, PullRequestStatus, SearchIssuesRequest, SortDirection,
    UpdateIssueRequest,
};
```

Also, find the existing `use super::{ ... };` block near the top of the `db::` import section (around line 18-26) and ensure it imports `IssueRepository::validate_move_request` or pull the symbol via `crate::db::issues::{validate_move_request, MoveValidationError}`. If not already imported, add:

```rust
use crate::db::issues::{validate_move_request, MoveValidationError};
```

- [ ] **Step 2: Add the handler function**

Insert this function above `pub(super) fn router()` (which lives at the bottom of the file — search for `pub fn router`). The new handler:

```rust
#[instrument(
    name = "issues.move_issue",
    skip(state, ctx),
    fields(
        issue_id = %issue_id,
        user_id = %ctx.user.id,
        destination_project_id = %payload.destination_project_id,
        destination_status_id = %payload.destination_status_id,
    )
)]
async fn move_issue(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(issue_id): Path<Uuid>,
    Json(payload): Json<MoveIssueRequest>,
) -> Result<Json<MutationResponse<Issue>>, ErrorResponse> {
    // 1. Load the source issue (404 if missing).
    let old_issue = IssueRepository::find_by_id(state.pool(), issue_id)
        .await
        .map_err(|error| {
            tracing::error!(?error, %issue_id, "failed to load issue");
            ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "failed to load issue")
        })?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "issue not found"))?;

    // 2. Pre-flight validation (pure).
    if let Err(MoveValidationError::SameDestination) =
        validate_move_request(old_issue.project_id, payload.destination_project_id)
    {
        return Err(ErrorResponse::new(
            StatusCode::BAD_REQUEST,
            "destination must differ from source",
        ));
    }

    // 3. Authz on BOTH projects; both must be in the same org.
    let src_org = ensure_project_access(state.pool(), ctx.user.id, old_issue.project_id).await?;
    let dst_org =
        ensure_project_access(state.pool(), ctx.user.id, payload.destination_project_id).await?;
    if src_org != dst_org {
        return Err(ErrorResponse::new(
            StatusCode::FORBIDDEN,
            "cross-org move not supported",
        ));
    }

    // 4. Single transaction.
    let mut tx = crate::db::begin_tx(state.pool()).await.map_err(|error| {
        tracing::error!(?error, "failed to begin transaction");
        ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    })?;

    let new_issue = IssueRepository::move_to_project(
        &mut *tx,
        issue_id,
        payload.destination_project_id,
        payload.destination_status_id,
    )
    .await
    .map_err(|error| match error {
        IssueError::InvalidDestinationStatus(_) => {
            ErrorResponse::new(StatusCode::BAD_REQUEST, "invalid destination status")
        }
        IssueError::DestinationProjectNotFound(_) => {
            ErrorResponse::new(StatusCode::NOT_FOUND, "destination project not found")
        }
        other => {
            tracing::error!(?other, "failed to move issue");
            ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "failed to move issue")
        }
    })?;

    let txid = get_txid(&mut *tx).await.map_err(|error| {
        tracing::error!(?error, "failed to get txid");
        ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    })?;

    tx.commit().await.map_err(|error| {
        tracing::error!(?error, "failed to commit transaction");
        ErrorResponse::new(StatusCode::INTERNAL_SERVER_ERROR, "internal server error")
    })?;

    // 5. Notify both source + destination subscribers via the existing path.
    notify_issue_update_changes(&state, dst_org, ctx.user.id, &old_issue, &new_issue).await;

    Ok(Json(MutationResponse {
        data: new_issue,
        txid,
    }))
}
```

- [ ] **Step 3: Register the route**

Find the existing `router()` function (around line 44):

```rust
pub fn router() -> axum::Router<AppState> {
    mutation()
        .router()
        .route("/issues/search", post(search_issues))
        .route("/issues/bulk", post(bulk_update_issues))
}
```

Add the new route:

```rust
pub fn router() -> axum::Router<AppState> {
    mutation()
        .router()
        .route("/issues/search", post(search_issues))
        .route("/issues/bulk", post(bulk_update_issues))
        .route("/issues/{id}/move", post(move_issue))
}
```

(Use `{id}` — that's the axum 0.8 placeholder syntax that the rest of the file uses. Check `mutation().router()` source if unsure — it should generate `:id`-style routes; mirror that.)

- [ ] **Step 4: Cargo check**

Run:
```
cd /srv/vibe-kanban/source && cargo check -p remote 2>&1 | tail -25
```
Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```
cd /srv/vibe-kanban/source && git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -m "feat(api): POST /api/issues/:id/move" -- crates/remote/src/routes/issues.rs
```

---

## Task 6 — Build the backend image and smoke-test against the dev DB

Done before frontend work so we know the endpoint actually responds.

- [ ] **Step 1: Build the backend in the dev container**

The dev container `vibe-kanban-dev` on `DockerKomodo` is where the build pipeline runs. Use the `dk_ssh` helper (see `docker-komodo` skill).

Run:
```
dk_ssh DockerKomodo 'sudo docker exec -w /workspace vibe-kanban-dev sh -c "cargo build --release -p remote 2>&1 | tail -10"'
```
Expected: `Finished` with no errors. Build time depends on cache state (cold: ~10-15 min).

If the dev container is missing `libclang-dev` (needed by `bindgen` on `libsqlite3-sys`):
```
dk_ssh DockerKomodo 'sudo docker exec -u root vibe-kanban-dev apt-get install -y libclang-dev'
```

- [ ] **Step 2: Smoke-test through the running container's port**

The cloud SaaS server is `vibe-kanban-server` on DockerKomodo, listening on a port mapped to host `8581`. Use the Komodo API to redeploy the stack after the build is in place:

```
KOMODO_KEY=$(op item get 'Komodo API - Claude-code' --vault 'API/SSH/Tokens' --fields username --reveal)
KOMODO_SECRET=$(op item get 'Komodo API - Claude-code' --vault 'API/SSH/Tokens' --fields password --reveal)
curl -sS -X POST http://10.10.0.162:9120/execute \
  -H "X-Api-Key: $KOMODO_KEY" -H "X-Api-Secret: $KOMODO_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"type":"DeployStack","params":{"stack":"vibe-kanban"}}' \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("_id",{}).get("$oid"))'
```

Capture the `DEPLOY_ID` and poll until `status: Complete` per the docker-komodo skill recipe.

- [ ] **Step 3: cURL the endpoint with an obviously-invalid id**

```
curl -sS -X POST http://10.10.0.162:8581/api/issues/00000000-0000-0000-0000-000000000000/move \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"destination_project_id":"00000000-0000-0000-0000-000000000000","destination_status_id":"00000000-0000-0000-0000-000000000000"}'
```
Expected: `404` with body `{"message":"issue not found"}` (a 401 means auth is required first — get a token from the browser DevTools).

If 404: backend deployment is live. Move to frontend.

---

## Task 7 — Add the `moveIssue` API helper in `remoteApi.ts`

**Files:**
- Modify: `packages/web-core/src/shared/lib/remoteApi.ts`

- [ ] **Step 1: Add the helper near `bulkUpdateIssues`**

Find the existing `bulkUpdateIssues` function (around line 125). Below it, add:

```ts
export interface MoveIssueParams {
  issueId: string;
  destinationProjectId: string;
  destinationStatusId: string;
}

/**
 * Move an issue to a different project in the same organization. Server
 * resolves the new `simple_id` (atomic counter bump on destination), reassigns
 * tags by name (auto-creating missing ones in destination), and places the
 * issue at the bottom of the destination's status-scoped column.
 */
export async function moveIssue(params: MoveIssueParams): Promise<void> {
  const response = await makeRequest(`/v1/issues/${params.issueId}/move`, {
    method: 'POST',
    body: JSON.stringify({
      destination_project_id: params.destinationProjectId,
      destination_status_id: params.destinationStatusId,
    }),
  });
  if (!response.ok) {
    let message = 'Failed to move issue';
    try {
      const error = await response.json();
      if (error && typeof error.message === 'string') {
        message = error.message;
      }
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(message);
  }
}
```

- [ ] **Step 2: Type-check**

Run:
```
cd /srv/vibe-kanban/source/packages/web-core && pnpm run check 2>&1 | tail -5
```
Expected: clean `tsc --noEmit` (exit 0, no error lines).

- [ ] **Step 3: Commit**

```
cd /srv/vibe-kanban/source && git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -m "feat(remote-api): add moveIssue helper" -- packages/web-core/src/shared/lib/remoteApi.ts
```

---

## Task 8 — Create the `MoveIssueDialog` component

**Files:**
- Create: `packages/web-core/src/pages/kanban/MoveIssueDialog.tsx`

- [ ] **Step 1: Write the component**

```tsx
/**
 * Dialog for moving an issue to a different project in the same organization.
 *
 * Two-step picker (project, then status) wired to the POST /api/issues/:id/move
 * endpoint. On success: toast + navigate to the new issue URL.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@vibe/ui/components/Dialog';
import { Button } from '@vibe/ui/components/Button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibe/ui/components/Select';
import { useToast } from '@/shared/hooks/useToast';
import { useOrgContext } from '@/shared/hooks/useOrgContext';
import { moveIssue } from '@/shared/lib/remoteApi';
import type { Issue, ProjectStatus } from 'shared/remote-types';

export interface MoveIssueDialogProps {
  issue: Issue;
  open: boolean;
  onClose: () => void;
}

export function MoveIssueDialog({ issue, open, onClose }: MoveIssueDialogProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const orgContext = useOrgContext();

  // 1. Same-org projects, excluding source.
  const projects = useMemo(
    () => (orgContext.projects ?? []).filter((p) => p.id !== issue.project_id),
    [orgContext.projects, issue.project_id]
  );

  const [destProjectId, setDestProjectId] = useState<string | null>(null);
  const [destStatusId, setDestStatusId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset selections whenever the dialog re-opens or the issue changes.
  useEffect(() => {
    if (open) {
      setDestProjectId(null);
      setDestStatusId(null);
      setSubmitting(false);
      setErrorMessage(null);
    }
  }, [open, issue.id]);

  // 2. Destination project statuses (non-hidden, ordered).
  const statusesQuery = useQuery({
    queryKey: ['project_statuses', destProjectId],
    enabled: !!destProjectId,
    queryFn: async (): Promise<ProjectStatus[]> => {
      const res = await fetch(`/v1/project_statuses?project_id=${destProjectId}`);
      if (!res.ok) throw new Error('Failed to load destination project statuses');
      const data = (await res.json()) as { data: ProjectStatus[] };
      return data.data;
    },
  });

  // Reset status selection when destination project changes.
  useEffect(() => {
    setDestStatusId(null);
  }, [destProjectId]);

  const eligibleStatuses = useMemo(
    () => (statusesQuery.data ?? []).filter((s) => !s.hidden),
    [statusesQuery.data]
  );

  const canSubmit =
    !!destProjectId &&
    !!destStatusId &&
    !submitting &&
    !statusesQuery.isLoading;

  const handleSubmit = async () => {
    if (!destProjectId || !destStatusId) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await moveIssue({
        issueId: issue.id,
        destinationProjectId: destProjectId,
        destinationStatusId: destStatusId,
      });
      const destProjectName = projects.find((p) => p.id === destProjectId)?.name ?? 'project';
      toast({ title: 'Moved', description: `Issue moved to ${destProjectName}.` });
      onClose();
      navigate({
        to: '/projects/$projectId/issues/$issueId',
        params: { projectId: destProjectId, issueId: issue.id },
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move issue</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-base">
          <div>
            <label className="block text-sm font-medium mb-half">Destination project</label>
            <Select
              value={destProjectId ?? ''}
              onValueChange={(v) => setDestProjectId(v || null)}
              disabled={submitting}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a project…" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-half">Destination status</label>
            <Select
              value={destStatusId ?? ''}
              onValueChange={(v) => setDestStatusId(v || null)}
              disabled={!destProjectId || statusesQuery.isLoading || submitting}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    !destProjectId
                      ? '(pick project first…)'
                      : statusesQuery.isLoading
                        ? 'Loading…'
                        : 'Select a status…'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {eligibleStatuses.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="text-xs text-low">
            The issue's ID will change (e.g. <code>{issue.simple_id}</code> → a new
            number in the destination project). Tags will be preserved by name;
            comments, assignees, sub-issues, and PR links carry over automatically.
          </div>

          {errorMessage && (
            <div className="text-sm text-destructive" role="alert">
              {errorMessage}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? 'Moving…' : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify imports exist**

The component assumes:
- `useToast` exists at `@/shared/hooks/useToast` — check with `grep -rn "useToast" packages/web-core/src/shared/hooks/`. If named differently, fix the import.
- `useOrgContext` exposes `projects: Project[] | undefined` — confirm with `grep -A20 "export function useOrgContext" packages/web-core/src/shared/hooks/useOrgContext.ts`. If the field is named differently, adjust `orgContext.projects` accordingly.
- `@vibe/ui/components/Dialog` / `Select` / `Button` exist — check with `ls packages/ui/src/components/ | grep -iE "Dialog|Select|Button"`. If a `Select` primitive doesn't exist, fall back to a native `<select>` element with the same logic.

Fix any naming mismatches inline.

- [ ] **Step 3: Type-check**

Run:
```
cd /srv/vibe-kanban/source/packages/web-core && pnpm run check 2>&1 | tail -10
```
Expected: clean.

- [ ] **Step 4: Commit**

```
cd /srv/vibe-kanban/source && git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -m "feat(kanban): add MoveIssueDialog component" -- packages/web-core/src/pages/kanban/MoveIssueDialog.tsx
```

---

## Task 9 — Add the `MoveIssue` command-bar action

**Files:**
- Modify: `packages/web-core/src/shared/actions/index.ts`

- [ ] **Step 1: Add an icon import**

Find the existing phosphor-icons import block at the top of the file (around lines 4–45). Add `ArrowSquareOutIcon` (or `ArrowsLeftRightIcon` if `ArrowSquareOutIcon` isn't already imported by `@phosphor-icons/react` — try the latter first since it's already imported on line ~40).

If `ArrowsLeftRightIcon` is already in the import list, no change needed.

- [ ] **Step 2: Add the action definition**

Find the existing `DeleteIssue` action (around line 1413). Add this **after** it (still inside the `Actions` object, before `DuplicateIssue`):

```ts
  MoveIssue: {
    id: 'move-issue',
    label: 'Move to project…',
    icon: ArrowsLeftRightIcon,
    shortcut: 'I M',
    requiresTarget: ActionTargetType.ISSUE,
    isVisible: (ctx) =>
      ctx.layoutMode === 'kanban' && ctx.hasSelectedKanbanIssue,
    execute: async (ctx, _projectId, issueIds) => {
      if (issueIds.length !== 1) {
        throw new Error('Can only move one issue at a time');
      }
      const issue = ctx.projectMutations?.getIssue?.(issueIds[0]);
      if (!issue) {
        throw new Error('Issue not found');
      }
      const { MoveIssueDialog } = await import(
        '@/pages/kanban/MoveIssueDialog'
      );
      // The dialog mounts itself; nothing to await here. Some action systems
      // require a `.show()` static-method pattern — if MoveIssueDialog needs
      // that, wrap it in a small `MoveIssueDialog.show({ issueId })` static
      // method using the same pattern as `LinkPrToIssueDialog.show`.
      MoveIssueDialog.show?.({ issueId: issueIds[0] });
    },
  } satisfies IssueActionDefinition,
```

Note: this assumes the codebase has a `Dialog.show()` static-method pattern used elsewhere (see `LinkPrToIssueDialog.show` referenced in `KanbanIssuePanelContainer.tsx:1016`). If `MoveIssueDialog` doesn't expose `.show()`, factor the dialog the same way `LinkPrToIssueDialog` does (declarative open/close from a singleton wrapper). Search for the pattern:
```
grep -rn "LinkPrToIssueDialog.show\|static.*show.*=.*async" packages/web-core/src/shared/dialogs
```
and mirror it for `MoveIssueDialog`. If this is the first dialog of its kind in the kanban dir, lift the singleton-show wrapper into a small `MoveIssueDialog.show.ts` neighbour file.

- [ ] **Step 3: Type-check**

Run:
```
cd /srv/vibe-kanban/source/packages/web-core && pnpm run check 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 4: Commit**

```
cd /srv/vibe-kanban/source && git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -m "feat(actions): add MoveIssue command-bar action" -- packages/web-core/src/shared/actions/index.ts packages/web-core/src/pages/kanban/MoveIssueDialog*.tsx
```

(The wildcard covers the case where you added a `MoveIssueDialog.show.ts` helper.)

---

## Task 10 — Reference `MoveIssue` in the `issueActions` page

**Files:**
- Modify: `packages/web-core/src/shared/command-bar/actions/pages.ts`

- [ ] **Step 1: Add `Actions.MoveIssue` to the items list**

Find the `issueActions` page (search for `issueActions: {`). In its `items[0].items` array (the Actions group), add a new line just before the existing `{ type: 'action', action: Actions.DuplicateIssue },` line:

```ts
          { type: 'action', action: Actions.MoveIssue },
          { type: 'action', action: Actions.DuplicateIssue },
          { type: 'action', action: Actions.DeleteIssue },
```

- [ ] **Step 2: Type-check**

Run:
```
cd /srv/vibe-kanban/source/packages/web-core && pnpm run check 2>&1 | tail -10
```
Expected: clean.

- [ ] **Step 3: Commit**

```
cd /srv/vibe-kanban/source && git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -m "feat(command-bar): expose MoveIssue on issueActions page" -- packages/web-core/src/shared/command-bar/actions/pages.ts
```

---

## Task 11 — Rebuild cloud UI image and verify end-to-end

- [ ] **Step 1: Rebuild local-web bundle (needed if local-web embeds web-core)**

This step is only needed for MintBox's host-mode binary, which embeds the local-web bundle. Skip if only touching the cloud UI:
```
cd /srv/vibe-kanban/source/packages/local-web && NODE_OPTIONS='--max-old-space-size=6144' pnpm run build 2>&1 | tail -5
```
Expected: `✓ built in <X>s`.

- [ ] **Step 2: Redeploy the cloud UI stack via Komodo**

```
KOMODO_KEY=$(op item get 'Komodo API - Claude-code' --vault 'API/SSH/Tokens' --fields username --reveal)
KOMODO_SECRET=$(op item get 'Komodo API - Claude-code' --vault 'API/SSH/Tokens' --fields password --reveal)
DEPLOY_ID=$(curl -sS -X POST http://10.10.0.162:9120/execute \
  -H "X-Api-Key: $KOMODO_KEY" -H "X-Api-Secret: $KOMODO_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"type":"DeployStack","params":{"stack":"vibe-kanban"}}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["_id"]["$oid"])')
echo "DEPLOY_ID=$DEPLOY_ID"
```

Poll until complete (the dev container build of the remote crate takes ~10–15 minutes cold):
```
until [ "$(curl -sS -X POST http://10.10.0.162:9120/read \
  -H "X-Api-Key: $KOMODO_KEY" -H "X-Api-Secret: $KOMODO_SECRET" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"GetUpdate\",\"params\":{\"id\":\"$DEPLOY_ID\"}}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])')" = "Complete" ]; do sleep 30; done
echo "deploy complete"
```

- [ ] **Step 3: Manual UAT (smoke checklist)**

Hard-refresh the browser (Ctrl/Cmd+Shift+R) on `vibing.andersontechsolutions.com` first — the service worker may otherwise serve the old bundle.

1. **Happy path same-org.** Open an issue in project A → kebab → Move to project… → pick project B → pick status `To Do` → submit → toast appears, URL changes to `/projects/<B>/issues/<id>`, the issue appears at the bottom of B's "To Do" column with a new `simple_id`.
2. **Tags preserved.** Pick an issue with two tags (one whose name exists in the destination project, one whose name doesn't). After move, both tag links exist; the matching one points at destination's existing tag (color unchanged); the new one was auto-created.
3. **Comments + assignees follow.** Spot-check the moved issue's comments and assignees still display.
4. **Bad status request (cURL).** `POST /api/issues/:id/move` with a `destination_status_id` from a different project → 400 with `invalid destination status`.
5. **Same-destination request (cURL).** `destination_project_id == source` → 400 with `destination must differ from source`.
6. **Source counter unchanged.** `SELECT issue_counter FROM projects WHERE id = <src>` before and after → equal.
7. **Stale URL graceful.** Visit the old `/projects/<old>/issues/<uuid>` URL → no crash. (Redirect is a deferred follow-up; just confirm the page doesn't blow up.)
8. **Cross-org guard.** Forge a `destination_project_id` belonging to a different org via cURL → 403 with `cross-org move not supported`.

- [ ] **Step 4: Final commit (only if any UAT-driven fixes were needed)**

```
cd /srv/vibe-kanban/source && git -c user.name='Ian Anderson' -c user.email='ian@andersontechsolutions.com' -c commit.gpgsign=false commit -am "fix(move-issue): UAT polish"
```

(Skip if no fixes.)

---

## Self-review (run after writing the plan)

### Spec coverage

| Spec section | Covered by task |
|---|---|
| Architecture file map | Tasks 1, 4, 5, 7, 8, 9, 10 |
| `MoveIssueRequest` type | Task 1 |
| Codegen registration | Task 2 |
| `validate_move_request` + unit test | Task 3 |
| `IssueRepository::move_to_project` SQL | Task 4 |
| Same-org enforced via dual `ensure_project_access` | Task 5 (handler step 2-3) |
| Status validation (belongs-to + non-hidden) | Task 4 (step 2, op 1) |
| Counter bump + simple_id via CTE | Task 4 (step 2, op 2) |
| Bottom-of-column status-scoped sort | Task 4 (step 2, op 3) |
| Tag upsert by name with ON CONFLICT DO NOTHING | Task 4 (step 2, op 4) |
| Atomic issue UPDATE | Task 4 (step 2, op 5) |
| `notify_issue_update_changes` reused | Task 5 (handler step 5) |
| Frontend kebab action via command bar | Tasks 9, 10 |
| Dialog with project picker + status picker | Task 8 |
| Navigate to new URL on success | Task 8 (handleSubmit) |
| Toast on success | Task 8 (handleSubmit) |
| Inline error banner | Task 8 (errorMessage) |
| Manual UAT smoke checklist | Task 11 |

All spec sections have a task.

### Placeholder scan

Searched the plan for "TBD", "TODO", "implement later", "add appropriate error handling", "similar to task". No matches. The two "verify imports exist" / "search for pattern" steps in Tasks 8 and 9 are concrete archaeology with explicit grep commands and fallback instructions — not placeholders.

### Type consistency

- `MoveIssueRequest { destination_project_id, destination_status_id }` used consistently in api-types (Task 1), routes (Task 5), helper (Task 7), dialog (Task 8). All four reference the same field names.
- `MoveValidationError::SameDestination` introduced in Task 3, consumed in Task 5. Names match.
- `IssueError::InvalidDestinationStatus` and `DestinationProjectNotFound` introduced in Task 4 (step 1), pattern-matched in Task 5 (step 2). Names match.
- `validate_move_request` signature `(Uuid, Uuid) -> Result<(), MoveValidationError>` used identically in both files.
- `moveIssue({ issueId, destinationProjectId, destinationStatusId })` shape used identically in `remoteApi.ts` (Task 7) and `MoveIssueDialog.tsx` (Task 8).
- `ActionTargetType.ISSUE`, `IssueActionDefinition` — match existing `DeleteIssue`/`DuplicateIssue` definitions.

All names line up.
