export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let handler: (body: unknown) => Promise<unknown> = async () => ({ id: "m1", revision: 1 });

export function setRunRequestApiHandler(next: (body: unknown) => Promise<unknown>) {
  handler = next;
}

export async function api<T>(_connection: unknown, _path: string, init?: { body?: unknown }): Promise<T> {
  return (await handler(init?.body)) as T;
}
