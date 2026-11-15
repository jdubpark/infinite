import type express from "express";

export type PermissionFence = { deliveryFence?: "uncertain" };

/**
 * Every API write settles the permission fence before its JSON reply is sent, so no route has to remember it.
 * An owner act that ends an authority (a revoke, a changed delegation, an opt-out, a regrouping, a halt) is
 * acknowledged only after answers in flight under that authority were fenced. `deliveryFence: "uncertain"` is
 * added to an object reply when a fence was not confirmed. Reads pass through untouched.
 */
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
