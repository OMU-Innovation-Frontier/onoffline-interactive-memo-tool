import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import worker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { access } from './store.js';
import { createRoom, getRoom, getRoomPdf, changeRoomPage, sendRoomNote } from './room-client.js';
import { maxRoomNoteLength, validRoomNoteText } from './room-note.js';

GlobalWorkerOptions.workerSrc = worker;
const el = id => document.getElementById(id);
const presenterKey = id => 'presenter:' + id;
const clock = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
let roomId = new URLSearchParams(location.search).get('room');
let presenterToken = roomId && sessionStorage.getItem(presenterKey(roomId));
let roomVersion = 0;
let roomNoteCount = 0;
let lastQueuedNote;
const queuedNoteStatus = '付箋を送信待ちに追加しました。';
const drafts = new Map();
let current;
let page = 0;
let busy = false;
const read = (table, op) => access(table, 'readonly', op);
const write = (table, op) => access(table, 'readwrite', op);

async function run(task, onError = () => {
  el('status').textContent = '処理に失敗しました。PDFの形式・パスワード保護・ブラウザーの保存容量をご確認ください。';
}) {
  if (busy) return;
  busy = true;
  document.querySelector('main').inert = true;
  el('status').textContent = '';
  try { await task(); }
  catch (error) { onError(error); }
  finally {
    document.querySelector('main').inert = false;
    el('decks').value = current?.id ?? '';
    const canTurn = !roomId || Boolean(presenterToken);
    el('prev').disabled = !canTurn || page <= 1;
    el('next').disabled = !canTurn || !current || page >= current.pdf.numPages;
    el('save').disabled = !current;
    el('create-room').disabled = Boolean(roomId) || !current;
    busy = false;
  }
}

async function render(deck, number) {
  const slide = await deck.pdf.getPage(number);
  const viewport = slide.getViewport({ scale: 1 });
  const scaled = slide.getViewport({ scale: 1600 / Math.max(viewport.width, viewport.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(scaled.width);
  canvas.height = Math.ceil(scaled.height);
  canvas.setAttribute('aria-label', deck.name + ' ' + number + 'ページ');
  await slide.render({canvasContext: canvas.getContext('2d'), viewport: scaled}).promise;
  if (roomId) {
    if (page) drafts.set(page, { text: el('body').value, kind: el('kind').value });
  } else {
    const notes = await read('notes', s => s.index('location').getAll([deck.id, number]));
    await write('settings', s => s.put({id: deck.id, page: number}, 'last'));
    showNotes(notes.sort((a,b) => a.time-b.time));
  }
  document.querySelector('canvas').replaceWith(canvas);
  el('empty').hidden = true;
  el('page').value = number + ' / ' + deck.pdf.numPages;
  const draft = drafts.get(number);
  el('body').value = draft?.text ?? '';
  if (draft) el('kind').value = draft.kind;
  current = deck;
  page = number;
}

function noteElement(note) {
  const item = document.createElement('li');
  const kind = document.createElement('strong');
  kind.textContent = note.kind;
  item.append(kind, note.text);
  return item;
}

function showNotes(notes) {
  const items = document.createDocumentFragment();
  for (const note of notes) items.append(noteElement(note));
  el('notes').replaceChildren(items);
}

async function openDeck(record, number = 1, isNew = false, name = record.file.name) {
  const loading = getDocument({data: await record.file.arrayBuffer(), isEvalSupported:false,
    cMapUrl:'/pdf-assets/cmaps/', cMapPacked:true, standardFontDataUrl:'/pdf-assets/standard_fonts/', wasmUrl:'/pdf-assets/wasm/'});
  const old = current;
  try {
    const pdf = await loading.promise;
    if (isNew) await write('decks', s => s.put(record));
    await render({id: record.id, name, pdf, file: record.file}, number);
  } catch (error) { await loading.destroy(); throw error; }
  if (old) await old.pdf.destroy();
  if (!roomId && ![...el('decks').options].some(option => option.value === record.id))
    el('decks').add(new Option(record.file.name, record.id));
}

function roomStatus(text) {
  const status = el('room-status');
  if (status.textContent !== text) status.textContent = text;
}

function showRoom() {
  el('local-tools').hidden = true;
  el('room-tools').hidden = false;
  el('room-role').textContent = presenterToken ? '発表者' : '参加者';
  el('share-tools').hidden = !presenterToken;
  el('empty').textContent = '共有資料を読み込んでいます…';
  el('body').maxLength = maxRoomNoteLength;
  roomStatus('接続中…');
  if (presenterToken) {
    const url = new URL('/', location.origin);
    url.searchParams.set('room', roomId);
    el('join-url').value = url.href;
    el('lan-hint').hidden = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  }
}

async function applyRoom(state) {
  const newerPage = state.version > roomVersion;
  // A late poll can arrive after a page change. Notes only grow within a page version.
  if (state.version < roomVersion || (!newerPage && state.notes.length <= roomNoteCount)) return;
  if (newerPage) {
    if (!current) {
      const record = await read('decks', s => s.get(state.deckId))
        ?? { id: state.deckId, file: await getRoomPdf(state) };
      await openDeck(record, state.page, false, state.name);
    } else if (page !== state.page) {
      await render(current, state.page);
    }
    roomVersion = state.version;
    const time = el('page-changed');
    time.dateTime = state.changedAt;
    time.textContent = '切替 ' + clock.format(new Date(state.changedAt));
    time.hidden = false;
  }
  showNotes(state.notes);
  roomNoteCount = state.notes.length;
}

function roomConnectionError(error) {
  if (error.status === 404) {
    roomStatus('会が見つかりません。参加URLをご確認ください。');
    if (!current) el('empty').textContent = '共有資料を表示できません';
  } else {
    roomStatus('同期できません。再接続しています…');
  }
}

async function sendQueuedNotes() {
  const notes = await read('roomNoteQueue', s => s.index('room').getAll(roomId));
  for (const note of notes.sort((a,b) => a.time-b.time)) {
    await sendRoomNote(note);
    await write('roomNoteQueue', s => s.delete([note.room, note.id]));
    if (note.id === lastQueuedNote && el('status').textContent === queuedNoteStatus) {
      el('status').textContent = '会に付箋を保存しました。';
    }
  }
}

async function pollRoom() {
  let delay = 1000;
  let status = '同期中';
  try {
    await sendQueuedNotes();
  } catch {
    delay = 3000;
    status = '未送信の付箋があります。再送しています…';
  }
  try {
    const state = await getRoom(roomId);
    if (!busy) {
      if (state.version > roomVersion) {
        await run(async () => {
          await applyRoom(state);
          roomStatus(status);
        }, error => {
          delay = 3000;
          roomConnectionError(error);
        });
      } else {
        await applyRoom(state);
        roomStatus(status);
      }
    }
  } catch (error) {
    if (!busy) roomConnectionError(error);
    delay = 3000;
  }
  setTimeout(pollRoom, delay);
}

function turnPage(offset) {
  run(async () => {
    if (!roomId) {
      await render(current, page + offset);
    } else if (presenterToken) {
      await applyRoom(await changeRoomPage(roomId, presenterToken, page + offset));
    }
  }, roomId ? roomConnectionError : undefined);
}

el('open').onclick = () => el('file').click();
el('file').onchange = () => run(async () => {
  const file = el('file').files[0];
  el('file').value = '';
  if (!file) return;
  const data = await file.arrayBuffer();
  const hash = crypto.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', data))
    : sha256(new Uint8Array(data));
  const id = bytesToHex(hash);
  await openDeck({id, file}, 1, true);
});
el('decks').onchange = () => run(async () => {
  if (el('decks').value) await openDeck(await read('decks', s => s.get(el('decks').value)));
});
el('prev').onclick = () => turnPage(-1);
el('next').onclick = () => turnPage(1);
el('create-room').onclick = () => run(async () => {
  const state = await createRoom(current.file, page, current.pdf.numPages);
  sessionStorage.setItem(presenterKey(state.id), state.presenterToken);
  roomId = state.id;
  presenterToken = state.presenterToken;
  history.replaceState(null, '', '?room=' + roomId);
  showRoom();
  await applyRoom(state);
  roomStatus('同期中');
  setTimeout(pollRoom, 1000);
}, error => {
  el('status').textContent = error.status === 413
    ? '会で共有できるPDFは64 MBまでです。'
    : '会を作成できませんでした。サーバーへの接続を確認して、もう一度お試しください。';
});
el('copy-url').onclick = async () => {
  const field = el('join-url');
  field.select();
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(field.value);
    else if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
    el('status').textContent = '参加URLをコピーしました。';
  } catch {
    el('status').textContent = '選択した参加URLをコピーしてください。';
  }
};
document.querySelector('form').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    const text = el('body').value.trim();
    if (!current || !text) { el('status').textContent = '付箋の内容を入力してください。'; return; }
    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const note = { id, page, kind: el('kind').value, text, time: Date.now() };
    if (roomId) {
      if (!validRoomNoteText(text)) {
        el('status').textContent = `会の付箋は有効な文字で${maxRoomNoteLength}文字以内で入力してください。`;
        return;
      }
      await write('roomNoteQueue', s => s.add({ ...note, room: roomId }));
      lastQueuedNote = id;
      el('status').textContent = queuedNoteStatus;
    } else {
      await write('notes', s => s.add({ ...note, deck: current.id }));
      el('notes').append(noteElement(note));
      el('status').textContent = 'この端末に保存しました。';
    }
    el('body').value = '';
  }, () => {
    el('status').textContent = '付箋を保存できませんでした。ブラウザーの保存容量をご確認ください。';
  });
};

async function restoreLocalDeck() {
  for (const id of await read('decks', s => s.getAllKeys())) {
    const record = await read('decks', s => s.get(id));
    el('decks').add(new Option(record.file.name, id));
  }
  const last = await read('settings', s => s.get('last'));
  if (last) await openDeck(await read('decks', s => s.get(last.id)), last.page);
}

if (roomId) {
  showRoom();
  pollRoom();
} else {
  run(restoreLocalDeck);
}
