import { log } from '@pat87creator/logger';

export type AlertSeverity = 'critical' | 'warning';
export type AlertService = 'worker' | 'api' | 'stripe' | 'system';
export type AlertEvent =
  | 'dead_letter'
  | 'webhook_failure'
  | 'worker_error'
  | 'health_failure'
  | 'margin_anomaly';

export type AlertPayload = {
  severity: AlertSeverity;
  service: AlertService;
  event: AlertEvent;
  message: string;
  metadata?: Record<string, unknown>;
};

export type AlertEnv = {
  ALERT_SLACK_WEBHOOK_URL?: string;
  ALERT_EMAIL_TO?: string;
};

const ALERT_INTERVAL_MS = 60_000;
const recentAlertTypes = new Map<string, number>();
const recentFingerprints = new Map<string, number>();

function cleanupRecentAlerts(now: number): void {
  for (const [key, timestamp] of recentAlertTypes.entries()) {
    if (now - timestamp > ALERT_INTERVAL_MS) {
      recentAlertTypes.delete(key);
    }
  }

  for (const [key, timestamp] of recentFingerprints.entries()) {
    if (now - timestamp > ALERT_INTERVAL_MS) {
      recentFingerprints.delete(key);
    }
  }
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(metadata)
    .filter(([key]) => {
      const lowered = key.toLowerCase();
      return !(
        lowered.includes('secret') ||
        lowered.includes('token') ||
        lowered.includes('authorization') ||
        lowered.includes('header') ||
        lowered.includes('cookie') ||
        lowered.includes('password')
      );
    })
    .map(([key, value]) => [key, value ?? null]);

  return Object.fromEntries(entries);
}

function fingerprintFor(alert: AlertPayload): string {
  return JSON.stringify({
    severity: alert.severity,
    service: alert.service,
    event: alert.event,
    message: alert.message,
    metadata: sanitizeMetadata(alert.metadata ?? {})
  });
}

function shouldRateLimit(alert: AlertPayload, now: number): { limited: boolean; reason: 'type' | 'duplicate' | null } {
  cleanupRecentAlerts(now);

  const typeKey = `${alert.service}:${alert.event}:${alert.severity}`;
  if (recentAlertTypes.has(typeKey)) {
    return { limited: true, reason: 'type' };
  }

  const fingerprint = fingerprintFor(alert);
  if (recentFingerprints.has(fingerprint)) {
    return { limited: true, reason: 'duplicate' };
  }

  recentAlertTypes.set(typeKey, now);
  recentFingerprints.set(fingerprint, now);
  return { limited: false, reason: null };
}

function buildSlackText(alert: AlertPayload): string {
  const emoji = alert.severity === 'critical' ? '🚨' : '⚠️';
  const metadata = sanitizeMetadata(alert.metadata ?? {});
  const metadataLines = Object.entries(metadata).map(([key, value]) => `• *${key}*: ${String(value)}`);

  return [
    `${emoji} *${alert.message}*`,
    `Service: ${alert.service}`,
    `Event: ${alert.event}`,
    ...metadataLines
  ].join('\n');
}

async function sendSlackAlert(alert: AlertPayload, webhookUrl: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      text: buildSlackText(alert)
    })
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed with status ${response.status}`);
  }
}

async function sendEmailAlert(alert: AlertPayload, emailTo: string): Promise<void> {
  log('warn', 'Email alert channel configured but not implemented; logging fallback used', {
    alert_event: alert.event,
    alert_service: alert.service,
    alert_severity: alert.severity,
    email_to: emailTo
  });
}

export async function dispatchAlert(alert: AlertPayload, env: AlertEnv): Promise<void> {
  const now = Date.now();
  const rateLimit = shouldRateLimit(alert, now);

  if (rateLimit.limited) {
    log('info', 'Alert suppressed by deduplication/rate limiting', {
      alert_event: alert.event,
      alert_service: alert.service,
      alert_severity: alert.severity,
      suppression_reason: rateLimit.reason
    });
    return;
  }

  const safeMetadata = sanitizeMetadata(alert.metadata ?? {});
  const safeAlert: AlertPayload = {
    ...alert,
    metadata: safeMetadata
  };

  log('warn', 'Dispatching operational alert', {
    alert_event: safeAlert.event,
    alert_service: safeAlert.service,
    alert_severity: safeAlert.severity,
    alert_message: safeAlert.message,
    metadata: safeAlert.metadata
  });

  const channelPromises: Promise<void>[] = [];

  if (env.ALERT_SLACK_WEBHOOK_URL) {
    channelPromises.push(sendSlackAlert(safeAlert, env.ALERT_SLACK_WEBHOOK_URL));
  }

  if (env.ALERT_EMAIL_TO) {
    channelPromises.push(sendEmailAlert(safeAlert, env.ALERT_EMAIL_TO));
  }

  if (channelPromises.length === 0) {
    log('warn', 'No alert channels configured; alert only logged', {
      alert_event: safeAlert.event,
      alert_service: safeAlert.service,
      alert_severity: safeAlert.severity
    });
    return;
  }

  await Promise.all(channelPromises);
}
