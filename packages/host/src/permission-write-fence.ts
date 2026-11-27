import type express from "express";

export type PermissionFence = { deliveryFence?: "uncertain" };

export function permissionWriteFence(settle: () => Promise<PermissionFence>): express.RequestHandler {
  return (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const json = res.json.bind(res);
    let settling = false;
    res.json = (body?: unknown) => {
      if (settling || res.headersSent) return json(body);
      settling = true;
      void settle().catch((): PermissionFence => ({ deliveryFence: "uncertain" })).then(fence => {
        if (res.headersSent || res.destroyed) return;
        json(fence.deliveryFence && body !== null && typeof body === "object" && !Array.isArray(body) ? { ...body, ...fence } : body);
      });
      return res;
    };
    next();
  };
}
