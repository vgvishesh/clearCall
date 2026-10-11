import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["./**/*.ts", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const imports = (src: string) =>
  [...src.matchAll(/^\s*(?:import|export)[^"']*["']([^"']+)["']/gm)].map((m) => m[1]!);

describe("core boundaries", () => {
  it("found the core sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(15);
  });

  it("src/core never imports from src/ui or preact rendering", () => {
    for (const [file, src] of Object.entries(sources)) {
      for (const spec of imports(src)) {
        expect(spec, file).not.toMatch(/(^|\/)ui\//);
        expect(spec, file).not.toMatch(/^preact($|\/)/);
      }
    }
  });

  it("app modules never import test fakes", () => {
    for (const [file, src] of Object.entries(sources)) {
      if (file.startsWith("./testing/") || file.startsWith("./fake/")) continue;
      for (const spec of imports(src)) expect(spec, file).not.toMatch(/testing\//);
    }
  });
});
