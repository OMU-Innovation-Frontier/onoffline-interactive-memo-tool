const ready = new Promise((resolve, reject) => {
  const request = indexedDB.open('lt-study-notes', 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('decks', { keyPath: 'id' });
    db.createObjectStore('notes', { keyPath: 'id' }).createIndex('location', ['deck', 'page']);
    db.createObjectStore('settings');
  };
  request.onsuccess = () => resolve(request.result);
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
