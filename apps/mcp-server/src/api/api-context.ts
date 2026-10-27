import type { DashboardSession } from "@studix/auth";
import { StudixError } from "@studix/shared";
import type { NextFunction, Request, Response } from "express";
import type { z } from "zod";
import type { DashboardAuthPort } from "../ports.ts";

/** Resolve the Better Auth session cookie into a TenantContext; 401 without a session. */
export function requireSession(auth: DashboardAuthPort) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const session = await auth.resolveSession(req.headers);
    if (!session) {
      throw new StudixError("UNAUTHENTICATED", "Sign in to use the dashboard API", {
        suggestedAction: "Sign in again.",
      });
    }
    res.locals.session = session;
    next();
  };
}

export function sessionOf(res: Response): DashboardSession {
  const session = res.locals.session as DashboardSession | undefined;
  if (!session) throw new StudixError("UNAUTHENTICATED", "No session");
  return session;
}

/** Parse request input with zod at the boundary; VALIDATION with field paths on failure. */
export function parseBody<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  throw new StudixError("VALIDATION", `Invalid ${what}`, {
    details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    suggestedAction: `Fix the listed ${what} fields and retry.`,
  });
}

/** Route params in Express 5 are strings; reject anything that cannot be an id. */
export function idParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
    throw new StudixError("VALIDATION", `Invalid ${name}`);
  }
  return value;
}
