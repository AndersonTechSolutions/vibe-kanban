use axum::{
    Json, Router,
    extract::{Extension, State},
    http::StatusCode,
    routing::{get, post},
};
use tracing::instrument;

use super::types::{SubscribeRequest, SubscribeResponse, VapidPublicKeyResponse};
use crate::{
    AppState,
    auth::RequestContext,
    routes::error::ErrorResponse,
};

pub fn public_router() -> Router<AppState> {
    Router::new().route("/push/vapid-public-key", get(get_vapid_public_key))
}

pub fn protected_router() -> Router<AppState> {
    Router::new().route("/push/subscribe", post(subscribe))
}

async fn get_vapid_public_key(
    State(state): State<AppState>,
) -> Result<Json<VapidPublicKeyResponse>, ErrorResponse> {
    let push = state.push().ok_or_else(|| {
        ErrorResponse::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "web push is not configured on this server",
        )
    })?;

    Ok(Json(VapidPublicKeyResponse {
        public_key: push.public_key().to_string(),
    }))
}

#[instrument(
    name = "push.subscribe",
    skip(state, ctx, payload),
    fields(user_id = %ctx.user.id)
)]
async fn subscribe(
    State(state): State<AppState>,
    Extension(ctx): Extension<RequestContext>,
    Json(payload): Json<SubscribeRequest>,
) -> Result<Json<SubscribeResponse>, ErrorResponse> {
    let push = state.push().ok_or_else(|| {
        ErrorResponse::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "web push is not configured on this server",
        )
    })?;

    push.subscribe(
        ctx.user.id,
        &payload.endpoint,
        &payload.keys.p256dh,
        &payload.keys.auth,
        payload.user_agent.as_deref(),
    )
    .await
    .map_err(|error| {
        tracing::error!(?error, "failed to upsert push subscription");
        ErrorResponse::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to save push subscription",
        )
    })?;

    Ok(Json(SubscribeResponse { ok: true }))
}
