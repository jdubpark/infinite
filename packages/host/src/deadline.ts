export function replyDeadline(ms: number, expired: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(() => setImmediate(expired), ms);
}
