import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const NETWORK_DECLARATION = 'const NETWORK = "eip155:24101" as const;';
const NETWORK_DECLARATION_WITHOUT_CONST = 'const NETWORK = "eip155:24101";';

function decodeHtml(code: string): string {
  return code
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function sellerExamples(): string[] {
  const examples: string[] = [];
  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const [, code] of readme.matchAll(/```ts\n([\s\S]*?)```/g)) {
    if (code!.includes("server.register(NETWORK")) examples.push(code!);
  }
  const sellers = readFileSync(join(root, "site", "docs", "sellers.html"), "utf8");
  for (const [, code] of sellers.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)) {
    const decoded = decodeHtml(code!);
    if (decoded.includes("server.register(NETWORK")) examples.push(decoded);
  }
  return examples;
}

test("every seller example declares the network literal", () => {
  const examples = sellerExamples();
  assert.equal(examples.length, 4, "expected the README example and the Express, Next.js and Hono examples");
  for (const example of examples) {
    assert.ok(example.includes(NETWORK_DECLARATION), "seller example must declare NETWORK with as const");
    assert.ok(!example.includes(NETWORK_DECLARATION_WITHOUT_CONST), "seller example must not declare NETWORK as a mutable string");
  }
});

test("the Express seller example type-checks as written", () => {
  const example = sellerExamples().find((code) => code.includes('import express from "express";') && code.includes("https://x402.incentiv.io"));
  assert.ok(example, "Express seller example not found");
  const dir = mkdtempSync(join(root, "tmp-seller-example-"));
  try {
    const source = example!.replace('from "@incentiv/x402"', 'from "../src/index.js"');
    writeFileSync(join(dir, "example.ts"), source);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["node"],
        noEmit: true,
      },
      include: ["example.ts"],
    }));
    const result = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "lib", "tsc.js"), "-p", join(dir, "tsconfig.json")], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
