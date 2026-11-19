import { defineConfig } from 'vite';
import { roomApi } from './room-server.js';

export default defineConfig({
  server: {
    fs: { deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.rooms/**'] },
    watch: { ignored: '**/.rooms/**' },
  },
  plugins: [{
    name: 'presentation-rooms',
    configureServer(server) {
      server.middlewares.use(roomApi(server.config.root));
    },
    configurePreviewServer(server) {
      server.middlewares.use(roomApi(server.config.root));
    },
  }],
});
