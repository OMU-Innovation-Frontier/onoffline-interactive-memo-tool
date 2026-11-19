import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const maxPdfBytes = 64 * 1024 * 1024;
const token = () => randomBytes(16).toString('hex');

class RoomError extends Error {
  constructor(status) {
    super(`Room API error ${status}`);
    this.status = status;
  }
}

async function readPdf(request) {
  if (Number(request.headers['content-length']) > maxPdfBytes) {
    throw new RoomError(413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxPdfBytes) throw new RoomError(413);
    chunks.push(chunk);
  }
  const pdf = Buffer.concat(chunks, size);
  if (!pdf.subarray(0, 1024).includes('%PDF-')) throw new RoomError(400);
  return pdf;
}

function pageNumber(header) {
  return typeof header === 'string' && /^[1-9]\d{0,8}$/.test(header) ? Number(header) : 0;
}

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function openRooms(root) {
  const folder = join(root, '.rooms');
  mkdirSync(folder, { recursive: true });
  const db = new DatabaseSync(join(folder, 'rooms.sqlite'));
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      presenter_token TEXT NOT NULL,
      deck_id TEXT NOT NULL,
      name TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      pdf BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS page_changes (
      version INTEGER PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id),
      page INTEGER NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS page_changes_room ON page_changes(room_id, version);
  `);
  return {
    db,
    create: db.prepare('INSERT INTO rooms VALUES (?, ?, ?, ?, ?, ?)'),
    state: db.prepare(`
      SELECT rooms.id, deck_id AS deckId, name, page_count AS pageCount,
             page, changed_at AS changedAt, version
      FROM rooms JOIN page_changes ON page_changes.room_id = rooms.id
      WHERE rooms.id = ? ORDER BY version DESC LIMIT 1
    `),
    pdf: db.prepare('SELECT pdf FROM rooms WHERE id = ?'),
    presenter: db.prepare('SELECT presenter_token AS token, page_count AS pageCount FROM rooms WHERE id = ?'),
    firstPage: db.prepare('INSERT INTO page_changes (room_id, page) VALUES (?, ?)'),
    changePage: db.prepare(`
      INSERT INTO page_changes (room_id, page)
      SELECT ?, ? WHERE ? <> (
        SELECT page FROM page_changes WHERE room_id = ? ORDER BY version DESC LIMIT 1
      )
    `),
  };
}

export function roomApi(root) {
  let rooms;
  return async (request, response, next) => {
    const path = request.url.split('?', 1)[0];
    if (path !== '/api/rooms' && !path.startsWith('/api/rooms/')) return next();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    try {
      rooms ??= openRooms(root);
      if (path === '/api/rooms' && request.method === 'POST') {
        const page = pageNumber(request.headers['x-page']);
        const pageCount = pageNumber(request.headers['x-page-count']);
        let name;
        try {
          name = decodeURIComponent(request.headers['x-pdf-name'] ?? '');
        } catch {
          throw new RoomError(400);
        }
        if (!name || name.length > 255 || !page || page > pageCount ||
            request.headers['content-type'] !== 'application/pdf') throw new RoomError(400);
        const pdf = await readPdf(request);
        const deckId = createHash('sha256').update(pdf).digest('hex');
        const id = token();
        const presenterToken = token();
        rooms.db.exec('BEGIN IMMEDIATE');
        try {
          rooms.create.run(id, presenterToken, deckId, name, pageCount, pdf);
          rooms.firstPage.run(id, page);
          rooms.db.exec('COMMIT');
        } catch (error) {
          rooms.db.exec('ROLLBACK');
          throw error;
        }
        return json(response, 201, { ...rooms.state.get(id), presenterToken });
      }

      const match = /^\/api\/rooms\/([a-f0-9]{32})(?:\/(pdf|page))?$/.exec(path);
      if (!match) throw new RoomError(404);
      const [, id, resource] = match;
      if (request.method === 'GET' && resource === 'pdf') {
        const document = rooms.pdf.get(id);
        if (!document) throw new RoomError(404);
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': document.pdf.byteLength,
          'Content-Disposition': 'attachment',
        });
        return response.end(document.pdf);
      }
      if (request.method === 'PUT' && resource === 'page') {
        const presenter = rooms.presenter.get(id);
        if (!presenter) throw new RoomError(404);
        if (request.headers.authorization !== `Bearer ${presenter.token}`) throw new RoomError(403);
        const page = pageNumber(request.headers['x-page']);
        if (!page || page > presenter.pageCount) throw new RoomError(400);
        rooms.changePage.run(id, page, page, id);
      } else if (request.method !== 'GET' || resource) {
        throw new RoomError(405);
      }
      const state = rooms.state.get(id);
      if (!state) throw new RoomError(404);
      json(response, 200, state);
    } catch (error) {
      request.resume();
      if (!(error instanceof RoomError)) console.error(error);
      if (!response.destroyed) json(response, error.status ?? 500, { error: error.status ?? 500 });
    }
  };
}
