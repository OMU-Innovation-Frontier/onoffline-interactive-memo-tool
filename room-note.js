export const maxRoomNoteLength = 4000;

export function validRoomNoteText(text) {
  return typeof text === 'string' && text.length > 0 && text.length <= maxRoomNoteLength &&
    text.trim() === text && !text.includes('\0') && text.isWellFormed();
}
