import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function arTraceTerminalBridge(): Plugin {
  return {
    name: 'serum-ar-trace-terminal-bridge',
    configureServer(server) {
      server.config.logger.info('[AR_TRACE] Terminal mirror active at POST /__ar-trace');
      server.middlewares.use('/__ar-trace', (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end('POST only');
          return;
        }

        const origin = request.headers.origin;
        const host = request.headers.host;
        if (origin && host) {
          try {
            if (new URL(origin).host !== host) {
              response.statusCode = 403;
              response.end('Origin not allowed');
              return;
            }
          } catch {
            response.statusCode = 400;
            response.end('Invalid Origin');
            return;
          }
        }

        const chunks: string[] = [];
        let totalBytes = 0;
        let rejected = false;
        request.on('data', (chunk: unknown) => {
          if (rejected) return;
          const textChunk = String(chunk);
          totalBytes += typeof chunk === 'string' ? new TextEncoder().encode(chunk).length : textChunk.length;
          if (totalBytes > 16_384) {
            rejected = true;
            response.statusCode = 413;
            response.end('Trace event too large');
            request.resume();
            return;
          }
          chunks.push(textChunk);
        });
        request.on('end', () => {
          if (rejected) return;
          try {
            const payload = JSON.parse(chunks.join('')) as { sessionId?: unknown; line?: unknown };
            if (typeof payload.sessionId !== 'string' || typeof payload.line !== 'string') {
              response.statusCode = 400;
              response.end('Invalid trace payload');
              return;
            }
            server.config.logger.info(`[AR_TRACE_PHONE ${payload.sessionId}] ${payload.line}`);
            response.statusCode = 204;
            response.end();
          } catch {
            response.statusCode = 400;
            response.end('Invalid JSON');
          }
        });
        request.on('error', () => {
          if (!response.headersSent) {
            response.statusCode = 400;
            response.end('Request failed');
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), arTraceTerminalBridge()],
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
