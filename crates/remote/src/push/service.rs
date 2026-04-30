use std::{env, sync::Arc};

use anyhow::{Context, Result, anyhow};
use sqlx::PgPool;
use uuid::Uuid;
use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, URL_SAFE_NO_PAD, VapidSignatureBuilder,
    WebPushClient, WebPushError, WebPushMessageBuilder,
};

use super::types::PushPayload;

const FAILURE_THRESHOLD: i32 = 5;

#[derive(Clone)]
pub struct PushService {
    pool: PgPool,
    vapid_public_key: String,
    vapid_private_key: Arc<String>,
    vapid_subject: Arc<String>,
    client: Arc<HyperWebPushClient>,
}

#[derive(sqlx::FromRow)]
struct PushSubscriptionRow {
    id: Uuid,
    endpoint: String,
    p256dh_key: String,
    auth_key: String,
    failed_attempts: i32,
}

impl PushService {
    pub fn from_env(pool: PgPool) -> Result<Self> {
        let vapid_public_key = env::var("VAPID_PUBLIC_KEY")
            .context("VAPID_PUBLIC_KEY must be set to enable Web Push")?;
        let vapid_private_key = env::var("VAPID_PRIVATE_KEY")
            .context("VAPID_PRIVATE_KEY must be set to enable Web Push")?;
        let vapid_subject = env::var("VAPID_SUBJECT")
            .context("VAPID_SUBJECT must be set to enable Web Push")?;

        if vapid_public_key.is_empty() || vapid_private_key.is_empty() || vapid_subject.is_empty()
        {
            return Err(anyhow!(
                "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT must all be non-empty"
            ));
        }

        Ok(Self {
            pool,
            vapid_public_key,
            vapid_private_key: Arc::new(vapid_private_key),
            vapid_subject: Arc::new(vapid_subject),
            client: Arc::new(HyperWebPushClient::new()),
        })
    }

    pub fn public_key(&self) -> &str {
        &self.vapid_public_key
    }

    pub async fn subscribe(
        &self,
        user_id: Uuid,
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        user_agent: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            r#"
            INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key, user_agent)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (endpoint) DO UPDATE
            SET user_id = EXCLUDED.user_id,
                p256dh_key = EXCLUDED.p256dh_key,
                auth_key = EXCLUDED.auth_key,
                user_agent = EXCLUDED.user_agent,
                last_seen_at = now(),
                failed_attempts = 0
            "#,
        )
        .bind(user_id)
        .bind(endpoint)
        .bind(p256dh)
        .bind(auth)
        .bind(user_agent)
        .execute(&self.pool)
        .await
        .context("failed to upsert push subscription")?;

        Ok(())
    }

    pub async fn send_to_user(&self, user_id: Uuid, payload: PushPayload) {
        let rows = match sqlx::query_as::<_, PushSubscriptionRow>(
            r#"
            SELECT id, endpoint, p256dh_key, auth_key, failed_attempts
            FROM push_subscriptions
            WHERE user_id = $1
            "#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(?error, %user_id, "failed to load push subscriptions");
                return;
            }
        };

        if rows.is_empty() {
            return;
        }

        let payload_bytes = match serde_json::to_vec(&payload) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(?error, "failed to serialize push payload");
                return;
            }
        };

        let futures = rows.into_iter().map(|row| {
            let payload_bytes = payload_bytes.clone();
            async move {
                let result = self.send_one(&row, &payload_bytes).await;
                self.handle_send_result(&row, result).await;
            }
        });

        futures::future::join_all(futures).await;
    }

    async fn send_one(
        &self,
        row: &PushSubscriptionRow,
        payload_bytes: &[u8],
    ) -> Result<(), WebPushError> {
        let subscription_info =
            SubscriptionInfo::new(&row.endpoint, &row.p256dh_key, &row.auth_key);

        let mut sig_builder = VapidSignatureBuilder::from_base64(
            &self.vapid_private_key,
            URL_SAFE_NO_PAD,
            &subscription_info,
        )?;
        sig_builder.add_claim("sub", self.vapid_subject.as_str());
        let signature = sig_builder.build()?;

        let mut builder = WebPushMessageBuilder::new(&subscription_info);
        builder.set_payload(ContentEncoding::Aes128Gcm, payload_bytes);
        builder.set_vapid_signature(signature);

        let message = builder.build()?;
        self.client.send(message).await
    }

    async fn handle_send_result(
        &self,
        row: &PushSubscriptionRow,
        result: Result<(), WebPushError>,
    ) {
        match result {
            Ok(()) => {
                if row.failed_attempts > 0 {
                    let _ = sqlx::query(
                        "UPDATE push_subscriptions SET failed_attempts = 0, last_seen_at = now() WHERE id = $1",
                    )
                    .bind(row.id)
                    .execute(&self.pool)
                    .await;
                }
            }
            Err(WebPushError::EndpointNotValid) | Err(WebPushError::EndpointNotFound) => {
                tracing::info!(
                    subscription_id = %row.id,
                    "deleting push subscription (endpoint gone)"
                );
                let _ = sqlx::query("DELETE FROM push_subscriptions WHERE id = $1")
                    .bind(row.id)
                    .execute(&self.pool)
                    .await;
            }
            Err(error) => {
                let next_attempts = row.failed_attempts + 1;
                if next_attempts >= FAILURE_THRESHOLD {
                    tracing::warn!(
                        subscription_id = %row.id,
                        ?error,
                        "deleting push subscription (max failures reached)"
                    );
                    let _ = sqlx::query("DELETE FROM push_subscriptions WHERE id = $1")
                        .bind(row.id)
                        .execute(&self.pool)
                        .await;
                } else {
                    tracing::warn!(
                        subscription_id = %row.id,
                        ?error,
                        attempts = next_attempts,
                        "push send failed; incrementing failure count"
                    );
                    let _ = sqlx::query(
                        "UPDATE push_subscriptions SET failed_attempts = $1 WHERE id = $2",
                    )
                    .bind(next_attempts)
                    .bind(row.id)
                    .execute(&self.pool)
                    .await;
                }
            }
        }
    }
}
