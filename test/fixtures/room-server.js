import { createServer } from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';
import { roomApi } from '../../room-server.js';

const handleRoomRequest = roomApi(workerData);
let dropped = false;

const server = createServer((request, response) => {
  if (request.method === 'PUT' && !dropped) {
    const end = response.end;
    response.end = function (...args) {
      if (this.statusCode === 204) {
        // The API has saved the note and is about to send the success response.
        dropped = true;
        this.destroy();
        return this;
      }
      return end.apply(this, args);
    };
  }
  void handleRoomRequest(request, response, () => response.writeHead(404).end());
});

server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
