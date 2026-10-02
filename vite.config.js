import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Production Content-Security-Policy. Scripts may only come from the app
 * itself (plus the inline boot script, allowed by hash), so injected markup
 * can never run code. Dev builds skip it: Vite's HMR needs inline scripts.
 */
function contentSecurityPolicy() {
  return {
    name: 'noctra-csp',
    apply: 'build',
    transformIndexHtml(html) {
      // Browsers normalise CRLF/CR to LF before hashing inline scripts, so
      // hash the normalised text. Otherwise Windows (CRLF) checkouts produce
      // a hash that never matches and the inline boot script is blocked.
      const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1].replace(/\r\n?/g, '\n'))
        .map((body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);
      const policy = [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(' ')}`.trim(),
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob: https: http://127.0.0.1:* http://localhost:*",
        "media-src 'self' data: blob: https:",
        "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:*",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-src 'none'"
      ].join('; ');
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n  <meta http-equiv="Content-Security-Policy" content="${policy}" />`
      );
    }
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    // Bind for remote/browser previews; only localhost and the sandbox
    // preview domain are accepted as Host headers.
    host: true,
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1']
  },
  build: {
    outDir: 'dist'
  }
});
