import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createFacilitatorApp } from "../src/facilitator/app.js";
import { siteRouter, SITE_DIR } from "../src/facilitator/site.js";

async function serve() {
  const { app } = createFacilitatorApp({ log: () => {} });
  const site = siteRouter();
  assert.ok(site, `site directory missing at ${SITE_DIR}`);
  app.use(site);
  app.use((_req, res) => void res.status(404).json({ error: "not_found" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((ok) => server.once("listening", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

test("the landing page and every docs page are served as HTML with a strict policy", async () => {
  const { base, close } = await serve();
  try {
    for (const path of ["/", "/docs/", "/docs/sellers", "/docs/buyers", "/docs/api"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/, path);
      assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/, path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
      const html = await res.text();
      assert.doesNotMatch(html, /<script/i, `${path} must not use script`);
    }
    const css = await fetch(base + "/style.css");
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  } finally {
    await close();
  }
});

test("every local link on every page points to a page that exists", async () => {
  const { base, close } = await serve();
  try {
    const pages = ["/", "/docs/", "/docs/sellers", "/docs/buyers", "/docs/api"];
    for (const page of pages) {
      const html = await (await fetch(base + page)).text();
      for (const [, href] of html.matchAll(/(?:href|src)="(\/[^"#]*)(?:#[^"]*)?"/g)) {
        const res = await fetch(base + href!);
        assert.equal(res.status, 200, `${page} links to ${href}`);
      }
    }
  } finally {
    await close();
  }
});

test("the API routes are not shadowed and unknown paths stay JSON 404", async () => {
  const { base, close } = await serve();
  try {
    const supported = await fetch(base + "/supported");
    assert.equal(supported.status, 200);
    assert.match(supported.headers.get("content-type") ?? "", /application\/json/);
    assert.ok(Array.isArray(((await supported.json()) as { kinds: unknown[] }).kinds));

    const missing = await fetch(base + "/nope");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });

    // The site is read-only: a POST to a page is not served.
    const post = await fetch(base + "/", { method: "POST" });
    assert.equal(post.status, 404);

    // Dotfiles and path traversal are not served.
    for (const path of ["/.git/config", "/..%2f..%2fpackage.json", "/%2e%2e/package.json"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 404, path);
    }
  } finally {
    await close();
  }
});

test("a missing site directory leaves the service without a site instead of failing", () => {
  const empty = join(mkdtempSync(join(tmpdir(), "x402-site-")), "absent");
  try {
    assert.equal(siteRouter(empty), undefined);
  } finally {
    rmSync(join(empty, ".."), { recursive: true, force: true });
  }
});
