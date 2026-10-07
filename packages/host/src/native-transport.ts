// Provider startup catalogs can exceed 12 MB. Bound individual messages and
// queued output separately, allowing a short burst of catalog responses.
export const NATIVE_MAX_MESSAGE = 32 * 1024 * 1024;
export const NATIVE_MAX_BUFFERED = 64 * 1024 * 1024;

// Compress only the cloud hop. Local provider sockets avoid repeated compression
// work; independent message contexts keep memory bounded across attachments.
export const NATIVE_COMPRESSION = {
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  zlibDeflateOptions: { level: 3 },
  concurrencyLimit: 2,
};
