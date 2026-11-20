import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { preview } from 'vite';

const server = await preview({
  root: workerData,
  configFile: fileURLToPath(new URL('../../vite.config.js', import.meta.url)),
  build: { outDir: fileURLToPath(new URL('../../dist', import.meta.url)) },
  preview: { host: '127.0.0.1', port: 0 },
});
parentPort.postMessage(`http://127.0.0.1:${server.httpServer.address().port}`);
