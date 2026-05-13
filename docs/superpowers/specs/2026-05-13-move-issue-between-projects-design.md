# Move issue between projects — design

**Status:** Approved (awaiting implementation plan)
**Scope:** v1 only. Single issue. Same organization. Manual fix for misfiled items.

## Goal

Let a user pick a misfiled issue and move it to a different project in the same organization, picking the destination status explicitly. Tags carry over by name; comments, assignees, sub-issue links, and PR links carry over automatically.

## Locked decisions (from brainstorming)

| Question | Answer |
|---|---|
| Scope | Single issue at a time, same org always, no bulk move |
| Status mapping | User picks destination status explicitly in the dialog (no auto-mapping) |
| Parent / child issues | Cross-project parent/child links are kept intact; the schema already allows them |
| Permissions | User must have access to both source AND destination project; same-org enforced |
| UI entry point | Issue-detail kebab menu in `KanbanIssuePanelContainer` |
| Sort order in destination | Bottom of the destination's status-scoped column (lands at the end of whatever Kanban column the user picked) |
| Tags | Name-match + auto-create missing tags in destination |
| Audit trail | None — `updated_at` bump + Electric sync covers it |
| Stale URLs | Out of scope for v1 (flagged as follow-up) |

## Architecture

| Layer | What changes |
|---|---|
| Shared types | **New:** `MoveIssueRequest { destination_project_id: Uuid, destination_status_id: Uuid }` in `shared/api-types`; regenerated via `crates/remote/src/bin/generate_types.rs` |
| Backend route | **New:** `POST /api/issues/:id/move` in `crates/remote/src/routes/issues.rs` |
| Backend repo method | **New:** `IssueRepository::move_to_project(&mut tx, ...)` in `crates/remote/src/db/issues.rs` |
| Frontend page | **Modified:** add **Move to project…** item to the issue-detail kebab in `packages/web-core/src/pages/kanban/KanbanIssuePanelContainer.tsx` |
| Frontend dialog | **New:** `MoveIssueDialog` in `packages/web-core/src/pages/kanban/MoveIssueDialog.tsx` |
| Frontend nav | On success, `useNavigate()` to `/projects/<new>/issues/<id>` + toast |
| Schema | **No change** |

## Backend — transaction details

### Route handler

```rust
// crates/remote/src/routes/issues.rs

#[derive(Debug, Deserialize, TS)]
pub struct MoveIssueRequest {
    pub destination_project_id: Uuid,
    pub destination_status_id: Uuid,
}

async fn move_issue(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Path(issue_id): Path<Uuid>,
    Json(payload): Json<MoveIssueRequest>,
) -> Result<Json<MutationResponse<Issue>>, ErrorResponse> {
    // 1. Load issue (404 if missing)
    let issue = IssueRepository::find_by_id(state.pool(), issue_id).await?
        .ok_or_else(|| ErrorResponse::new(StatusCode::NOT_FOUND, "issue not found"))?;

    // 2. Authz: same-org access on BOTH projects.
    let src_org = ensure_project_access(state.pool(), ctx.user.id, issue.project_id).await?;
    let dst_org = ensure_project_access(state.pool(), ctx.user.id, payload.destination_project_id).await?;
    if src_org != dst_org {
        return Err(ErrorResponse::new(StatusCode::FORBIDDEN, "cross-org move not supported"));
    }

    // 3. Reject same-destination no-op
    if issue.project_id == payload.destination_project_id {
        return Err(ErrorResponse::new(StatusCode::BAD_REQUEST, "destination must differ from source"));
    }

    // 4. Single transaction
    let mut tx = state.pool().begin().await?;
    let updated = IssueRepository::move_to_project(
        &mut *tx,
        issue_id,
        payload.destination_project_id,
        payload.destination_status_id,
    ).await?;
    let txid = get_txid(&mut *tx).await?;
    tx.commit().await?;

    // 5. Sync notification — reuse existing path
    notify_issue_update_changes(&state, dst_org, ctx.user.id, &issue, &updated).await;

    Ok(Json(MutationResponse { data: updated, txid }))
}
```

### Repo method — operations in order

```rust
// crates/remote/src/db/issues.rs::IssueRepository

pub async fn move_to_project(
    tx: &mut PgConnection,
    issue_id: Uuid,
    dst_project_id: Uuid,
    dst_status_id: Uuid,
) -> Result<Issue, IssueError> {
    // a) Validate dst_status_id belongs to dst_project_id AND is not hidden.
    //    SELECT id FROM project_statuses
    //    WHERE id = $1 AND project_id = $2 AND hidden = false
    //    -> no row -> domain error mapped to 400 "invalid destination status"

    // b) Atomically bump the destination project's issue_counter and read its org's prefix.
    //    UPDATE projects SET issue_counter = issue_counter + 1
    //    WHERE id = $1
    //    RETURNING issue_counter, organization_id
    //    -> no row -> domain error mapped to 404 "project not found"
    //
    //    SELECT issue_prefix FROM organizations WHERE id = $org_id
    //    -> compose new_simple_id = format!("{prefix}-{counter}")

    // c) Compute bottom-of-column sort_order in destination.
    //    SELECT COALESCE(MAX(sort_order), 0) + 1.0
    //    FROM issues
    //    WHERE project_id = $1 AND status_id = $2

    // d) Tag preservation: read source tag rows and upsert names into destination.
    //    For each (tag_name, tag_color) from `tags` JOIN `issue_tags` WHERE issue_id = $1:
    //      INSERT INTO tags (project_id, name, color)
    //      VALUES ($dst, $name, $color)
    //      ON CONFLICT (project_id, name) DO NOTHING
    //      RETURNING id;
    //    Then re-read by (project_id, name) when ON CONFLICT skipped insert.
    //    Build the new (issue_id, tag_id) link list.
    //
    //    DELETE FROM issue_tags WHERE issue_id = $1;
    //    INSERT INTO issue_tags (issue_id, tag_id) VALUES ...;

    // e) Atomic UPDATE of issues row.
    //    UPDATE issues
    //    SET project_id = $1, status_id = $2, issue_number = $3,
    //        simple_id = $4, sort_order = $5, updated_at = NOW()
    //    WHERE id = $6
    //    RETURNING * (all fields used by `Issue`)

    // f) Return the updated Issue.
}
```

### Why each step

| Concern | How it's handled |
|---|---|
| Race on `issue_counter` | `UPDATE ... SET counter = counter + 1 RETURNING counter` is atomic in Postgres. |
| `(project_id, issue_number)` uniqueness | New counter is unique-by-construction. |
| Status belongs to project | Validated up front in (a). |
| Source `issue_counter` | Left unchanged. Vacated number becomes a permanent gap (Linear/Jira/GitHub behavior). |
| Sort order | Status-scoped MAX → bottom of the user-chosen Kanban column. |
| Transaction isolation | Default READ COMMITTED is fine; no read-then-write race other than the atomic counter UPDATE. |
| Cascade rows | `issue_assignees` / `issue_comments` / `issue_comment_reactions` / `issue_followers` / `issue_relationships` / `pull_request_issues` all FK on `issues.id` — no changes needed. |
| Notifications | `notify_issue_update_changes` reused; Electric sync delivers the row diff to subscribers in both projects. |

## Tag handling — name-match + auto-create

Tags are per-project (`tags.project_id NOT NULL REFERENCES projects(id)`). After move, an issue's existing `issue_tags` rows would point at tags belonging to the *source* project — data inconsistency.

For each source-project tag attached to the moving issue:

1. `INSERT INTO tags (project_id, name, color) VALUES ($dst, $src_name, $src_color) ON CONFLICT (project_id, name) DO NOTHING` — destination already has this tag → no-op; missing tag → create with the source's color.
2. Read the destination tag id back via `SELECT id FROM tags WHERE project_id = $dst AND name = $src_name`.
3. Delete the issue's existing `issue_tags` rows.
4. Insert new `issue_tags` rows pointing at destination tag ids.

Same transaction as the issue update. If the destination already has a tag by that name, its existing color wins (not overwritten by source).

## Frontend

### Where to plug in

Both files live in `packages/web-core/src/pages/kanban/`:

- `ProjectKanban.tsx` — the kanban view
- `KanbanIssuePanelContainer.tsx` — the issue-detail panel; the kebab menu lives here. Add the **Move to project…** item as a sibling of the existing actions.

### New component `MoveIssueDialog`

Location: `packages/web-core/src/pages/kanban/MoveIssueDialog.tsx`

Props:

```ts
interface MoveIssueDialogProps {
  issue: Issue;
  open: boolean;
  onClose: () => void;
}
```

Behaviour:

- **Step 1 — project pick.** Dropdown of same-org projects, excluding source. Loaded from the existing org-projects query (cached).
- **Step 2 — status pick.** When a project is selected, query the destination project's non-hidden statuses (`GET /api/projects/:id/statuses?hidden=false` or whatever the existing endpoint is — discover during implementation). Default to the first option, user can change.
- **Submit.** `POST /api/issues/:id/move` with `{ destination_project_id, destination_status_id }`. Button spinner while pending.
- **Success.** Toast `Moved to <project name>`, close dialog, `useNavigate()` to `/projects/<new>/issues/<id>`.
- **Error.** Inline banner; dialog stays open; selections preserved; retry enabled.

### Visual sketch

```
┌────────────────────────────────────────┐
│  Move issue                         ×  │
├────────────────────────────────────────┤
│  Destination project                   │
│  [ Select a project… ▼ ]               │
│                                        │
│  Destination status                    │
│  [ (pick project first…) ▼ ]           │
│                                        │
│  ⓘ The issue's ID will change          │
│    (e.g. BLO-5 → BLO-23).              │
│  ⓘ Tags will be preserved by name;     │
│    comments, assignees, sub-issues,    │
│    and PR links carry over.            │
│                                        │
│       [ Cancel ]   [ Move ]            │
└────────────────────────────────────────┘
```

### Optimistic UI

**No.** Wait for the 200 + Electric sync to deliver the row change naturally. Avoids inconsistency if server rejects.

## Errors

### Server-side validation matrix

| Condition | HTTP | Message |
|---|---|---|
| `issue_id` not found | 404 | `issue not found` |
| `destination_project_id` not found OR user lacks access | 403 | `project not found or access denied` (don't leak existence to non-members) |
| Source and destination orgs differ | 403 | `cross-org move not supported` |
| `destination_project_id == source_project_id` | 400 | `destination must differ from source` |
| `destination_status_id` not found, wrong project, or hidden | 400 | `invalid destination status` |
| User lacks access to source project | 403 | (same as project-not-found case) |

### Race conditions

| Race | Outcome |
|---|---|
| Two moves of the same issue at once | Row locks serialise the `UPDATE issues … WHERE id = $1`. Second wins. Both clients see the same final state via Electric. |
| Concurrent insert into destination while moving in | `UPDATE projects SET issue_counter = issue_counter + 1 RETURNING …` is atomic — each gets a unique counter. |
| Source issue deleted mid-tx | Final `UPDATE issues … RETURNING` returns 0 rows → 404. |
| Destination project deleted mid-tx | Counter `UPDATE … RETURNING` returns 0 rows → 404. |
| Destination status deleted mid-tx | FK violation on the `UPDATE issues SET status_id = ?` → rollback → 400. |

### Tag edge cases

| Case | Behaviour |
|---|---|
| Issue has zero tags | Tag loop is a no-op |
| Source tag name already exists in destination | `ON CONFLICT DO NOTHING`; destination's existing color is preserved |
| Source tag name doesn't exist in destination | Created with source's color |

### Frontend edge cases

| Case | Behaviour |
|---|---|
| User switches destination project mid-flow | Status dropdown re-queries; previous status selection cleared |
| Submits with an in-flight status query | Confirm disabled until status query resolves |
| Network failure during submit | Inline retry banner; selections preserved |
| Server 403 (cross-org) | Inline message; project dropdown should have filtered it out — defensive only |
| Server 400 (invalid status) | Reload status list, prompt re-selection |
| User holds stale bookmark to old URL after move | v1: kanban panel renders "issue not found" gracefully. Redirect is a separate follow-up. |
| Two open tabs, one performs move | Other tab's Electric sync delivers the row change; panel resolves to blank or "not found." Acceptable for v1. |

### Notifications

Reuse the existing `notify_issue_update_changes`. The Electric subscription delivers the row diff to followers of the issue and members of both projects. Move is treated as an **update**, not an **insert** — destination project's `notify_on_issue_created` does NOT fire. Followers of the issue who are members of the new project still receive change events as before.

## Out of scope (v1)

- Move history / audit log (use `updated_at` and Electric stream)
- Bulk move from list view
- Cross-org move
- Stale-URL redirect (`/projects/<old>/issues/<uuid>` → new project URL)
- "Undo move" affordance
- Dedicated `issue.moved` webhook event

## Testing

Existing test culture in the remote crate is minimal — one inline unit test in `db/issues.rs` for a string-escape function; no DB-fixture harness; one component test across the whole `packages/web-core`. The plan matches that bar.

### In this PR

**Backend — inline unit tests in `crates/remote/src/db/issues.rs`:**

| Test | Asserts |
|---|---|
| `move_rejects_same_destination` | The same-destination guard fires *before* any DB read/write (testable as a pure function or via a mocked tx) |

Note: this is the *only* logic the repo method has that's not SQL-shaped. Everything else (counter increment, FK validation, tag upsert) is database behaviour and would need `#[sqlx::test]` infrastructure to cover — deferred below.

**Frontend — no new component tests.** No precedent in the kanban code.

### Manual UAT (smoke checklist after deploy)

1. **Happy path same-org.** Issue in project A → kebab → Move to project… → pick B → pick `To Do` → submit → toast, navigation, issue appears at bottom of B's `To Do` column with new `simple_id`.
2. **Tags preserved.** Issue with two tags (one name-match in destination, one not) → after move, both tag links exist; matching one points at destination's existing tag; the new one is auto-created.
3. **Comments + assignees follow.** Spot-check that they persist.
4. **Bad status.** POST with `destination_status_id` from a different project → 400 `invalid destination status`.
5. **Same destination.** POST with `destination_project_id == source` → 400.
6. **Source counter unchanged.** `SELECT issue_counter FROM projects WHERE id = $src` before and after → equal.
7. **Stale URL graceful.** Visit old `/projects/<old>/issues/<uuid>` → no crash. Flagged as redirect follow-up.
8. **Cross-org guard.** Forge `destination_project_id` in another org → 403.

### Deferred (would need infra investment)

- `#[sqlx::test]` integration coverage of the move transaction (counter race, tag upsert race, FK rollback).
- Component test for `MoveIssueDialog`.
- Playwright/E2E through the relay.
