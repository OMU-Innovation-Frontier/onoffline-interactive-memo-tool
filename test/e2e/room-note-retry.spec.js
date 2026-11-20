import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { chromium, expect, test as base } from '@playwright/test';

const test = base.extend({
  appUrl: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'room-note-e2e-'));
    const worker = new Worker(new URL('../fixtures/room-browser-server.js', import.meta.url), { workerData: root });
    try {
      const [url] = await once(worker, 'message', { signal: AbortSignal.timeout(10000) });
      await use(url);
    } finally {
      // Release the API's SQLite handle before removing its temporary directory on Windows.
      await worker.terminate();
      await rm(root, { recursive: true, force: true });
    }
  },
  room: async ({ appUrl, request }, use) => {
    const roomsUrl = `${appUrl}/api/rooms`;
    const response = await request.post(roomsUrl, {
      headers: {
        'Content-Type': 'application/pdf',
        'X-Pdf-Name': 'one-page.pdf',
        'X-Page': '1',
        'X-Page-Count': '1',
      },
      data: await readFile(new URL('../fixtures/one-page.pdf', import.meta.url)),
    });
    expect(response.status()).toBe(201);
    const { id } = await response.json();
    await use({ id, url: `${roomsUrl}/${id}` });
  },
  participantPage: async ({ appUrl, room }, use) => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${appUrl}/?room=${room.id}`);
      await expect(page.locator('#room-status')).toHaveText('同期中');
      await use(page);
    } finally {
      await browser.close();
    }
  },
});

test('a queued room note keeps its ID across reload and syncs once to both browsers after reconnecting', async ({ appUrl, room, context, page, participantPage, request }) => {
  const { id: roomId, url: roomUrl } = room;
  const note = { page: 1, kind: '質問', text: '再読み込み後に再送する付箋' };
  const notes = page.locator('#notes').getByRole('listitem');
  const participantNotes = participantPage.locator('#notes').getByRole('listitem');
  const isRoomApi = ({ pathname }) => pathname === '/api/rooms' || pathname.startsWith('/api/rooms/');
  const isNotePut = req => req.method() === 'PUT' && req.url().startsWith(`${roomUrl}/notes/`);
  const readQueue = async () => {
    const { origins } = await context.storageState({ indexedDB: true });
    const origin = origins.find(entry => entry.origin === appUrl);
    const db = origin.indexedDB.find(entry => entry.name === 'lt-study-notes');
    return db.stores.find(store => store.name === 'roomNoteQueue').records.map(record => record.value);
  };

  await page.goto(`${appUrl}/?room=${roomId}`);
  const save = page.getByRole('button', { name: '付箋を保存' });
  await expect(save).toBeEnabled();
  await context.route(isRoomApi, route => route.abort('internetdisconnected'));
  await page.getByLabel('種類').selectOption(note.kind);
  await page.getByLabel('付箋の内容').fill(note.text);
  const [firstAttempt] = await Promise.all([
    page.waitForEvent('requestfailed', isNotePut),
    save.click(),
  ]);
  await expect(page.locator('#status')).toHaveText('付箋を送信待ちに追加しました。');
  const queued = await readQueue();
  expect(queued).toEqual([expect.objectContaining({
    room: roomId,
    id: expect.stringMatching(/^[0-9a-f]{32}$/),
    ...note,
  })]);
  const [{ id }] = queued;
  const noteUrl = `${roomUrl}/notes/${id}`;
  expect(firstAttempt.url()).toBe(noteUrl);

  const [offlineRetry] = await Promise.all([
    page.waitForEvent('requestfailed', isNotePut),
    page.reload(),
  ]);
  expect(offlineRetry.url()).toBe(noteUrl);
  await expect(page.locator('#room-status')).toHaveText('同期できません。再接続しています…');
  expect(await readQueue()).toEqual(queued);
  await expect(notes).toHaveCount(0);
  await expect(participantNotes).toHaveCount(0);
  const offlineState = await request.get(roomUrl);
  await expect(offlineState).toBeOK();
  expect((await offlineState.json()).notes).toEqual([]);

  const [retry] = await Promise.all([
    page.waitForResponse(response => isNotePut(response.request())),
    context.unroute(isRoomApi),
  ]);
  expect(retry.url()).toBe(noteUrl);
  expect(retry.request().postDataJSON()).toEqual(note);
  expect(retry.status()).toBe(204);
  await expect(notes).toHaveText([note.kind + note.text]);
  await expect(notes.first()).toBeVisible();
  await expect(participantNotes).toHaveText([note.kind + note.text]);
  await expect(participantNotes.first()).toBeVisible();
  await expect.poll(readQueue).toEqual([]);

  const recoveredState = await request.get(roomUrl);
  await expect(recoveredState).toBeOK();
  expect((await recoveredState.json()).notes).toEqual([{ id, kind: note.kind, text: note.text }]);
});

test('a saved room note is retried with the same ID and syncs once to both browsers after its response is lost', async ({ appUrl, room, page, participantPage, request }) => {
  const notesUrl = `${room.url}/notes/`;
  const note = { page: 1, kind: '質問', text: '保存の成功応答が失われた付箋' };
  const isNotePut = req => req.method() === 'PUT' && req.url().startsWith(notesUrl);
  const participantNotes = participantPage.locator('#notes').getByRole('listitem');

  await page.goto(`${appUrl}/?room=${room.id}`);
  const save = page.getByRole('button', { name: '付箋を保存' });
  await expect(save).toBeEnabled();
  await expect(participantNotes).toHaveCount(0);
  await page.route(`${notesUrl}*`, async route => {
    try {
      // Complete the real save before simulating the loss of its response in Chromium.
      const response = await route.fetch();
      expect(response.status()).toBe(204);
      const savedState = await request.get(room.url);
      await expect(savedState).toBeOK();
      const id = route.request().url().slice(notesUrl.length);
      expect((await savedState.json()).notes).toEqual([{ id, kind: note.kind, text: note.text }]);
    } finally {
      await route.abort('connectionreset');
    }
  }, { times: 1 });

  await page.getByLabel('種類').selectOption(note.kind);
  await page.getByLabel('付箋の内容').fill(note.text);
  const [firstAttempt, retry] = await Promise.all([
    page.waitForEvent('requestfailed', isNotePut),
    page.waitForResponse(response => isNotePut(response.request())),
    save.click(),
  ]);
  const id = firstAttempt.url().slice(notesUrl.length);
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(firstAttempt.postDataJSON()).toEqual(note);
  expect(retry.url()).toBe(firstAttempt.url());
  expect(retry.request().postDataJSON()).toEqual(note);
  expect(retry.status()).toBe(204);

  await expect(page.locator('#status')).toHaveText('会に付箋を保存しました。');
  const notes = page.locator('#notes').getByRole('listitem');
  await expect(notes).toHaveText([note.kind + note.text]);
  await expect(notes.first()).toBeVisible();

  const recoveredState = await request.get(room.url);
  await expect(recoveredState).toBeOK();
  expect((await recoveredState.json()).notes).toEqual([{ id, kind: note.kind, text: note.text }]);

  // The participant can see the first save before the retry, so check its next room poll too.
  const participantPoll = await participantPage.waitForRequest(req =>
    req.method() === 'GET' && req.url() === room.url);
  const participantState = await participantPoll.response();
  expect(participantState?.status()).toBe(200);
  expect((await participantState.json()).notes).toEqual([{ id, kind: note.kind, text: note.text }]);
  await expect(participantNotes).toHaveText([note.kind + note.text]);
  await expect(participantNotes.first()).toBeVisible();
});
