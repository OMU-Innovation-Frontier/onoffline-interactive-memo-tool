class RoomRequestError extends Error {
  constructor(status) {
    super(`Room request failed: ${status}`);
    this.status = status;
  }
}

async function request(path, options = {}, timeout = 5000) {
  const response = await fetch('/api/rooms' + path, {
    signal: AbortSignal.timeout(timeout),
    ...options,
  });
  if (!response.ok) throw new RoomRequestError(response.status);
  return response;
}

export async function createRoom(file, page, pageCount) {
  const response = await request('', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Pdf-Name': encodeURIComponent(file.name),
      'X-Page': page,
      'X-Page-Count': pageCount,
    },
    body: file,
  }, 60000);
  return response.json();
}

export async function getRoom(id) {
  const response = await request('/' + encodeURIComponent(id));
  return response.json();
}

export async function getRoomPdf(state) {
  const response = await request('/' + state.id + '/pdf', {}, 60000);
  return new File([await response.blob()], state.name, { type: 'application/pdf' });
}

export async function changeRoomPage(id, presenterToken, page) {
  const response = await request('/' + id + '/page', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + presenterToken, 'X-Page': page },
  });
  return response.json();
}
