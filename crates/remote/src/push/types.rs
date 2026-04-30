use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct SubscribeKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubscribeRequest {
    pub endpoint: String,
    pub keys: SubscribeKeys,
    pub user_agent: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct VapidPublicKeyResponse {
    pub public_key: String,
}

#[derive(Debug, Serialize)]
pub struct SubscribeResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PushPayload {
    pub title: String,
    pub body: String,
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deeplink_path: Option<String>,
}
