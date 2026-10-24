import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const WORLD_TRACKING_BRIDGE_PATH = '/__world_tracking_debug';
const WORLD_TRACKING_MAX_BODY_BYTES = 64 * 1024;
const WORLD_TRACKING_MAX_RECORDS = 70;
const BRIDGE_REJECTION_LOG_INTERVAL_MS = 10_000;

interface RejectionLogWindow {
  lastLoggedAt: number;
  suppressedCount: number;
  latestDiagnostics: Record<string, unknown>;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase().replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
}

function isDevelopmentNetworkAddress(address: string): boolean {
  const normalized = normalizeAddress(address);
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254);
}

function parseOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function parseConfiguredOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((value) => {
    const trimmed = value.trim();
    const origin = parseOrigin(trimmed);
    if (origin) return origin;
    if (trimmed.endsWith('/')) return parseOrigin(trimmed.slice(0, -1));
    return null;
  }).filter((origin): origin is string => origin !== null))];
}

function headerValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // If a trusted proxy appends a forwarding chain, use its final value.
  const last = value.split(',').map((part) => part.trim()).filter(Boolean).at(-1) ?? '';
  return last.length > 0 && last.length <= 255 ? last : null;
}

function originForHost(protocol: string, host: string | null): string | null {
  if ((protocol !== 'http:' && protocol !== 'https:') || !host || /[\s,/?#@\\]/.test(host)) return null;
  try {
    const parsed = new URL(`${protocol}//${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function normalizedHostForLog(host: string | null): string | null {
  const origin = originForHost('http:', host);
  return origin ? new URL(origin).host : host ? '<invalid-host>' : null;
}

function normalizedProtocolForLog(value: string | null): 'http' | 'https' | '<invalid>' | null {
  if (!value) return null;
  const protocol = value.toLowerCase().replace(/:$/, '');
  return protocol === 'http' || protocol === 'https' ? protocol : '<invalid>';
}

function worldTrackingDevelopmentBridge(env: Record<string, string>): Plugin {
  const requestWindows = new Map<string, { startedAt: number; count: number }>();
  const recentlyPrinted = new Map<string, number>();
  const rejectionWindows = new Map<string, RejectionLogWindow>();
  const configuredAllowedOrigins = parseConfiguredOrigins(env.WORLD_AR_BRIDGE_ALLOWED_ORIGINS);
  // Loopback is the default trusted peer for local HTTPS tunnel agents. Add exact proxy IPs explicitly.
  const trustedProxyAddresses = new Set([
    '127.0.0.1',
    '::1',
    ...(env.WORLD_AR_BRIDGE_TRUSTED_PROXIES ?? '').split(',').map((address) => normalizeAddress(address.trim())).filter(Boolean),
  ]);

  const logRejectedRequest = (
    server: Parameters<NonNullable<Plugin['configureServer']>>[0],
    reason: string,
    remoteClass: string,
    diagnostics: Record<string, unknown>
  ) => {
    const now = Date.now();
    const key = `${reason}:${remoteClass}`;
    const existing = rejectionWindows.get(key);
    if (!existing) {
      rejectionWindows.set(key, { lastLoggedAt: now, suppressedCount: 0, latestDiagnostics: diagnostics });
      server.config.logger.warn(`[WORLD_AR][BRIDGE][REJECTED] reason=${reason} diagnostics=${JSON.stringify(diagnostics)}`);
      return;
    }

    existing.suppressedCount += 1;
    existing.latestDiagnostics = diagnostics;
    if (now - existing.lastLoggedAt < BRIDGE_REJECTION_LOG_INTERVAL_MS) return;

    server.config.logger.warn(`[WORLD_AR][BRIDGE][REJECTED] reason=${reason} suppressedRequests=${existing.suppressedCount} windowMs=${now - existing.lastLoggedAt} diagnostics=${JSON.stringify(existing.latestDiagnostics)}`);
    existing.lastLoggedAt = now;
    existing.suppressedCount = 0;
  };

  return {
    name: 'world-tracking-development-bridge',
    apply: 'serve',
    configureServer(server) {
      server.config.logger.info(`[WORLD_AR] Terminal bridge active at POST ${WORLD_TRACKING_BRIDGE_PATH}; configuredOrigins=${configuredAllowedOrigins.length}; trustedProxyPeers=${trustedProxyAddresses.size}`);
      server.middlewares.use((request: any, response: any, next: () => void) => {
        const path = String(request.url ?? '').split('?', 1)[0];
        if (path !== WORLD_TRACKING_BRIDGE_PATH) return next();
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.setHeader('Allow', 'POST');
          response.end('POST only');
          return;
        }

        const remoteAddress = String(request.socket?.remoteAddress ?? '');
        const normalizedRemoteAddress = normalizeAddress(remoteAddress);
        const trustedProxy = trustedProxyAddresses.has(normalizedRemoteAddress);
        const forwardedHostHeader = headerValue(request.headers['x-forwarded-host']);
        const forwardedProtocolHeader = headerValue(request.headers['x-forwarded-proto']);
        const hasForwardedHeaders = forwardedHostHeader !== null || forwardedProtocolHeader !== null;
        const socketProtocol = request.socket?.encrypted ? 'https:' : 'http:';
        const hostHeader = headerValue(request.headers.host);
        const directOrigin = originForHost(socketProtocol, hostHeader);
        const forwardedProtocol = normalizedProtocolForLog(forwardedProtocolHeader);
        const forwardedOrigin = trustedProxy && hasForwardedHeaders
          ? originForHost(
            forwardedProtocol === 'https' ? 'https:' : forwardedProtocol === 'http' ? 'http:' : socketProtocol,
            forwardedHostHeader || hostHeader
          )
          : null;
        const receivedOrigin = parseOrigin(String(request.headers.origin ?? ''));
        const expectedOrigins = [...new Set([
          ...configuredAllowedOrigins,
          ...(directOrigin ? [directOrigin] : []),
          ...(forwardedOrigin ? [forwardedOrigin] : []),
        ])];
        const sameOrigin = receivedOrigin !== null && expectedOrigins.includes(receivedOrigin);
        const privateClient = isDevelopmentNetworkAddress(remoteAddress);
        const remoteAllowed = privateClient || trustedProxy;
        const failedConditions: string[] = [];
        if (receivedOrigin === null) failedConditions.push('origin_missing_or_invalid');
        else if (!sameOrigin) failedConditions.push('origin_or_protocol_mismatch');
        if (hasForwardedHeaders && !trustedProxy) failedConditions.push('forwarded_headers_ignored_untrusted_peer');
        if (trustedProxy && hasForwardedHeaders && !forwardedOrigin) failedConditions.push('trusted_forwarded_origin_invalid');
        if (!remoteAllowed) failedConditions.push('non_private_client_or_untrusted_proxy');

        if (!sameOrigin || !remoteAllowed) {
          const reason = !sameOrigin ? 'origin_or_protocol_mismatch' : 'non_private_client';
          const origin = receivedOrigin ?? (request.headers.origin ? '<invalid-origin>' : null);
          const remoteClass = trustedProxy ? 'trusted-proxy' : privateClient ? 'private' : 'public';
          logRejectedRequest(server, reason, remoteClass, {
            method: String(request.method ?? 'UNKNOWN').replace(/[^A-Z]/gi, '').slice(0, 12),
            pathname: WORLD_TRACKING_BRIDGE_PATH,
            receivedOrigin: origin,
            expectedOrAllowedOrigins: expectedOrigins,
            host: normalizedHostForLog(hostHeader),
            forwardedHost: normalizedHostForLog(forwardedHostHeader),
            forwardedProtocol,
            trustedProxyPeer: trustedProxy,
            forwardedHeadersTrusted: hasForwardedHeaders && trustedProxy,
            actualConnectionProtocol: socketProtocol.slice(0, -1),
            remoteAddress: remoteAddress.slice(0, 64),
            remoteAddressClass: remoteClass,
            failedConditions,
          });
          response.statusCode = 403;
          response.end('Development bridge access denied');
          return;
        }

        const now = Date.now();
        if (requestWindows.size > 500) {
          for (const [address, bucket] of requestWindows) {
            if (now - bucket.startedAt >= 60_000) requestWindows.delete(address);
          }
        }
        const rate = requestWindows.get(remoteAddress);
        if (!rate || now - rate.startedAt >= 10_000) {
          requestWindows.set(remoteAddress, { startedAt: now, count: 1 });
        } else if (rate.count >= 30) {
          response.statusCode = 429;
          response.end('Development bridge rate limit exceeded');
          return;
        } else {
          rate.count += 1;
        }

        const declaredLength = Number(request.headers['content-length'] ?? 0);
        if (declaredLength > WORLD_TRACKING_MAX_BODY_BYTES) {
          response.statusCode = 413;
          response.end('Payload too large');
          return;
        }

        let body = '';
        let bodyBytes = 0;
        let rejected = false;
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => {
          if (rejected) return;
          bodyBytes += new TextEncoder().encode(chunk).byteLength;
          if (bodyBytes > WORLD_TRACKING_MAX_BODY_BYTES) {
            rejected = true;
            response.statusCode = 413;
            response.end('Payload too large');
            request.resume();
            return;
          }
          body += chunk;
        });
        request.on('end', () => {
          if (rejected) return;
          let envelope: any;
          try {
            envelope = JSON.parse(body);
          } catch {
            response.statusCode = 400;
            response.end('Invalid JSON');
            return;
          }
          if (typeof envelope?.sessionId !== 'string' || !Array.isArray(envelope.records) || envelope.records.length > WORLD_TRACKING_MAX_RECORDS) {
            response.statusCode = 400;
            response.end('Invalid debug record envelope');
            return;
          }

          const sessionId = envelope.sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'UNKNOWN';
          for (const record of envelope.records) {
            if (!record || typeof record !== 'object') continue;
            const sequenceId = Number.isSafeInteger(record.sequenceId) ? record.sequenceId : 0;
            const monotonicKey = `${sessionId}:${sequenceId}`;
            const previouslyPrintedAt = recentlyPrinted.get(monotonicKey);
            if (previouslyPrintedAt && now - previouslyPrintedAt < 60_000) continue;
            recentlyPrinted.set(monotonicKey, now);
            const rawTimestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
            const timestamp = Number.isFinite(rawTimestamp) ? new Date(rawTimestamp).toISOString() : new Date(now).toISOString();
            const xrFrame = String(record.xr8FrameId ?? record.trackingFrameSequence ?? '-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || '-';
            const category = typeof record.category === 'string' ? record.category.replace(/[^A-Z_]/g, '').slice(0, 16) : 'DEBUG';
            const eventName = typeof record.eventName === 'string' ? record.eventName.replace(/[^A-Z0-9_]/g, '').slice(0, 64) : 'EVENT';
            const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
            server.config.logger.info(`[WORLD_AR][${sessionId}][${timestamp}][F${xrFrame}][${category}][${eventName}] ${JSON.stringify({
              ...payload,
              sequenceId,
              monotonicMs: Number.isFinite(record.monotonicMs) ? record.monotonicMs : null,
              xr8FrameId: record.xr8FrameId ?? null,
              trackingFrameSequence: record.trackingFrameSequence ?? null,
              trackingState: typeof record.trackingState === 'string' ? record.trackingState : 'UNKNOWN',
            })}`);
          }
          if (recentlyPrinted.size > 20_000) {
            for (const [key, printedAt] of recentlyPrinted) {
              if (now - printedAt > 60_000) recentlyPrinted.delete(key);
            }
          }
          response.statusCode = 204;
          response.end();
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), worldTrackingDevelopmentBridge(env)],
    server: {
      host: true,
      port: 5173,
      cors: true,
    },
    preview: {
      host: true,
      port: 4173,
    },
    build: {
      target: 'esnext',
      assetsInlineLimit: 0,
    },
  };
});
