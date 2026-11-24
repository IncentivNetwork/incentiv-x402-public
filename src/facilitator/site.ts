import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { Router } from "express";

/** The landing page and docs, as plain files. From both `src/facilitator` and `dist/facilitator` this is `<root>/site`. */
export const SITE_DIR = fileURLToPath(new URL("../../site", import.meta.url));

/**
 * Serves the landing page (`/`) and the docs (`/docs/...`) from `dir`. It answers only GET and HEAD for files that
 * exist; every other request falls through. It is mounted by main.ts after the API routes, so the facilitator's own
 * paths (`/supported`, `/verify`, `/settle`, `/health`, `/discovery/*`) are never shadowed, and a library user of
 * `createFacilitatorApp` gets no site unless they add it.
 *
 * The pages need no script, so the content security policy allows none.
 */
export function siteRouter(dir: string = SITE_DIR): Router | undefined {
  if (!existsSync(dir)) return undefined;
  const router = Router();
  router.use(
    express.static(dir, {
      index: "index.html",
      extensions: ["html"],
      dotfiles: "ignore",
      maxAge: "5m",
      setHeaders: (res) => {
        res.setHeader(
          "content-security-policy",
          "default-src 'none'; style-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("referrer-policy", "no-referrer");
      },
    }),
  );
  return router;
}
