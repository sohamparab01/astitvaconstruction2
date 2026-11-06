import { defineConfig } from 'vite';
import path from 'path';
import fs from 'fs';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
    watch: {
      ignored: ['**/frames/**', '**/Project1.mp4'],
    },
  },
  plugins: [
    {
      name: 'serve-frames-middleware',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const rawUrl = req.url ? req.url.split('?')[0] : '';
          if (rawUrl.startsWith('/frames/')) {
            try {
              const safePath = path.normalize(path.join(process.cwd(), decodeURIComponent(rawUrl)));
              if (safePath.startsWith(process.cwd()) && fs.existsSync(safePath)) {
                const stat = fs.statSync(safePath);
                if (stat.isFile()) {
                  res.setHeader('Content-Type', 'image/png');
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
