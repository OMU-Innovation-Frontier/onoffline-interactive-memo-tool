const ready = new Promise((resolve, reject) => {
  const request = indexedDB.open('lt-study-notes', 2);
  request.onupgradeneeded = event => {
    const db = request.result;
    if (event.oldVersion < 1) {
      db.createObjectStore('decks', { keyPath: 'id' });
      db.createObjectStore('notes', { keyPath: 'id' }).createIndex('location', ['deck', 'page']);
      db.createObjectStore('settings');
    }
    db.createObjectStore('roomNoteQueue', { keyPath: ['room', 'id'] }).createIndex('room', 'room');
  };
  request.onsuccess = () => {
    const db = request.result;
    db.onversionchange = () => db.close();
    resolve(db);
  };
  request.onerror = () => reject(request.error);
});

export async function access(table, mode, operation) {
  const db = await ready;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(table, mode);
    const request = operation(tx.objectStore(table));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error);
  });
}
