import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';

export default defineConfig({
  base: '/astitvaconstruction2/',
  server: {
    port: 5173,
    open: false,
    watch: {
      ignored: ['**/frames/**', '**/frames_webp/**', '**/Project1.mp4'],
    },
  },
  plugins: [
    {
      name: 'serve-frames-middleware',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const rawUrl = req.url ? req.url.split('?')[0] : '';
          const cleanUrl = rawUrl.replace(/^\/astitvaconstruction2\//, '/');
          if (cleanUrl.startsWith('/frames/') || cleanUrl.startsWith('/frames_webp/')) {
            try {
              let safePath = path.normalize(path.join(process.cwd(), 'public', decodeURIComponent(cleanUrl)));
              if (!fs.existsSync(safePath)) {
                safePath = path.normalize(path.join(process.cwd(), decodeURIComponent(cleanUrl)));
              }
              if (safePath.startsWith(process.cwd()) && fs.existsSync(safePath)) {
                const stat = fs.statSync(safePath);
                if (stat.isFile()) {
                  const isWebp = cleanUrl.endsWith('.webp');
                  res.setHeader('Content-Type', isWebp ? 'image/webp' : 'image/png');
                  res.setHeader('Content-Length', stat.size);
                  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
                  const stream = fs.createReadStream(safePath);
                  stream.on('error', () => {
                    if (!res.headersSent) res.statusCode = 500;
                    res.end();
                  });
                  req.on('close', () => {
                    stream.destroy();
                  });
                  return stream.pipe(res);
                }
              }
            } catch (err) {
              // Pass to next middleware on unexpected error
            }
          }
          next();
        });
      },
    },
  ],
});
