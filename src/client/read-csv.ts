export function decodeCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('Choose a UTF-8 encoded CSV. The selected file could not be decoded without changing its content.');
  }
}
