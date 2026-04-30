import { makeRequest } from '@/shared/lib/remoteApi';

export interface VapidPublicKeyResponse {
  public_key: string;
}

export interface PushSubscriptionRequestBody {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  user_agent?: string;
}

export interface PushSubscribeResponse {
  ok: boolean;
}

export class PushApiUnavailableError extends Error {
  constructor() {
    super('Web Push is not configured on this server');
    this.name = 'PushApiUnavailableError';
  }
}

export async function getPushVapidPublicKey(): Promise<VapidPublicKeyResponse> {
  // The vapid-public-key endpoint is mounted in v1_public (no auth gate),
  // so we hit it without makeRequest's auth header. Use the runtime base URL
  // through makeRequest anyway so it picks up self-hosted overrides.
  const response = await makeRequest('/v1/push/vapid-public-key', {
    method: 'GET',
  });
  if (response.status === 503) {
    throw new PushApiUnavailableError();
  }
  if (!response.ok) {
    throw new Error(`vapid-public-key fetch failed: ${response.status}`);
  }
  return response.json();
}

export async function subscribePush(
  endpoint: string,
  p256dh: string,
  auth: string,
  userAgent?: string
): Promise<PushSubscribeResponse> {
  const body: PushSubscriptionRequestBody = {
    endpoint,
    keys: { p256dh, auth },
  };
  if (userAgent) {
    body.user_agent = userAgent;
  }

  const response = await makeRequest('/v1/push/subscribe', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (response.status === 503) {
    throw new PushApiUnavailableError();
  }
  if (!response.ok) {
    throw new Error(`push subscribe failed: ${response.status}`);
  }
  return response.json();
}
