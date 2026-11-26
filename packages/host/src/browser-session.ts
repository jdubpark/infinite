import type { Request } from "express";

export function browserSessionCookie(req: Pick<Request, "headers">): string | undefined {
  return req.headers.cookie
    ?.split(";")
    .map(value => value.trim())
    .find(value => value.startsWith("infinite="))
    ?.slice(9);
}
