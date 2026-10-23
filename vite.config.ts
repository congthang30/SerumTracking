import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const WORLD_TRACKING_BRIDGE_PATH = '/__world_tracking_debug';
const WORLD_TRACKING_MAX_BODY_BYTES = 64 * 1024;
const WORLD_TRACKING_MAX_RECORDS = 70;

function isDevelopmentNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 169 && parts[1] === 254);
}

function worldTrackingDevelopmentBridge(): Plugin {
  const requestWindows = new Map<string, { startedAt: number; count: number }>();
  const recentlyPrinted = new Map<string, number>();

  return {
    name: 'world-tracking-development-bridge',
    apply: 'serve',
    configureServer(server) {
      server.config.logger.info(`[WORLD_AR] Terminal bridge active at POST ${WORLD_TRACKING_BRIDGE_PATH}`);
      server.middlewares.use((request: any, response: any, next: () => void) => {
        const path = String(request.url ?? '').split('?', 1)[0];
        if (path !== WORLD_TRACKING_BRIDGE_PATH) return next();
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.setHeader('Allow', 'POST');
          response.end('POST only');
          return;
        }

        const forwardedHost = String(request.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
        const host = forwardedHost || String(request.headers.host ?? '');
        const origin = String(request.headers.origin ?? '');
        const forwardedProtocol = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
        const protocol = forwardedProtocol === 'https' || forwardedProtocol === 'http'
          ? `${forwardedProtocol}:`
          : request.socket?.encrypted ? 'https:' : 'http:';
        let sameOrigin = false;
        try {
          const parsedOrigin = new URL(origin);
          sameOrigin = parsedOrigin.host === host && parsedOrigin.protocol === protocol;
        } catch {
          sameOrigin = false;
        }
        const remoteAddress = String(request.socket?.remoteAddress ?? '');
        if (!sameOrigin || !isDevelopmentNetworkAddress(remoteAddress)) {
          server.config.logger.warn(`[WORLD_AR][BRIDGE][REJECTED] reason=${!sameOrigin ? 'origin_or_protocol_mismatch' : 'non_private_client'}`);
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

export default defineConfig({
  plugins: [react(), worldTrackingDevelopmentBridge()],
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
});
