import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

test('retrying a note after losing the save response leaves exactly one SQLite row', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'room-note-retry-'));
  // Terminating the worker releases the API's SQLite handle before cleanup on Windows.
  const worker = new Worker(new URL('./fixtures/room-server.js', import.meta.url), { workerData: root });
  t.after(async () => {
    await worker.terminate();
    await rm(root, { recursive: true, force: true });
  });

  const [port] = await once(worker, 'message', { signal: AbortSignal.timeout(5000) });
  const roomsUrl = `http://127.0.0.1:${port}/api/rooms`;
  const room = await fetch(roomsUrl, {
    method: 'POST',
    headers: {
      'Connection': 'close',
      'Content-Type': 'application/pdf',
      'X-Pdf-Name': 'test.pdf',
      'X-Page': '1',
      'X-Page-Count': '1',
    },
    body: '%PDF-1.7\n%%EOF\n',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(room.status, 201);
  const { id: roomId } = await room.json();

  const id = randomBytes(16).toString('hex');
  const note = { page: 1, kind: '質問', text: '応答を受け取れなかった付箋' };
  const sendNote = () => fetch(`${roomsUrl}/${roomId}/notes/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(note),
    signal: AbortSignal.timeout(5000),
  });

  await assert.rejects(sendNote, error => error.cause?.code === 'UND_ERR_SOCKET');

  using db = new DatabaseSync(join(root, '.rooms', 'rooms.sqlite'), { readOnly: true });
  const savedNotes = db.prepare('SELECT room_id AS roomId, id, page, kind, text FROM notes');
  const expected = [{ roomId, id, ...note }];
  assert.deepEqual(savedNotes.all().map(row => ({ ...row })), expected, 'saved before the response was lost');

  const retry = await sendNote();
  assert.equal(retry.status, 204);
  assert.deepEqual(savedNotes.all().map(row => ({ ...row })), expected, 'still one row after retry');
});
