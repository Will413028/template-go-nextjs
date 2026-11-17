// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cruise, type ICruiseOptions } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The rules in .dependency-cruiser.cjs pass silently when a pattern matches nothing, so this file proves each rule
// still fires on a deliberate violation (through the real options, @/ alias included) and that every directory a
// rule names exists.
const require = createRequire(import.meta.url);
type Rule = NonNullable<
  NonNullable<ICruiseOptions["ruleSet"]>["forbidden"]
>[number];
const config = require("../../.dependency-cruiser.cjs") as {
  forbidden: Rule[];
  options: ICruiseOptions;
};
const frontendRoot = join(import.meta.dirname, "..", "..");

// Every ^src/<dir>/ or ^src/(a|b)/ a rule's from or to names.
const ruleDirs = [
  ...new Set(
    [
      ...JSON.stringify(config.forbidden).matchAll(
        /\^src\/(?:\(([^)]+)\)|([a-z][\w-]*))\//g,
      ),
    ].flatMap((m) => (m[1] ?? m[2] ?? "").split("|")),
  ),
];
const sharedFrom = config.forbidden.find(
  (r) => r.name === "shared-not-to-features-or-app",
)?.from;
const sharedPath =
  sharedFrom && "path" in sharedFrom ? String(sharedFrom.path) : "";
const sharedDirs =
  /^\^src\/\(([^)]+)\)\/$/.exec(sharedPath)?.[1]?.split("|") ?? [];

type Files = Record<string, string>;
const cases: [string, Files][] = [
  [
    "no-circular",
    { "src/lib/a.ts": 'import "./b";', "src/lib/b.ts": 'import "./a";' },
  ],
  ["not-to-unresolvable", { "src/lib/a.ts": 'import "@/nowhere";' }],
  ...sharedDirs.map((dir): [string, Files] => [
    "shared-not-to-features-or-app",
    {
      [`src/${dir}/a.ts`]: 'import "@/features/x";',
      "src/features/x/index.ts": "",
    },
  ]),
  [
    "features-not-to-app",
    { "src/features/x/a.ts": 'import "@/app/page";', "src/app/page.ts": "" },
  ],
  [
    "feature-public-api-from-outside",
    {
      "src/app/page.ts": 'import "@/features/x/internal";',
      "src/features/x/internal.ts": "",
    },
  ],
  [
    "feature-public-api-between-features",
    {
      "src/features/y/a.ts": 'import "../x/internal";',
      "src/features/x/internal.ts": "",
    },
  ],
];

describe("dependency rules", () => {
  it("name only directories that exist", () => {
    expect(sharedDirs.length).toBeGreaterThan(0);
    for (const dir of ruleDirs) {
      expect(existsSync(join(frontendRoot, "src", dir)), `src/${dir}`).toBe(
        true,
      );
    }
  });

  let tmp = "";
  // realpath: on macOS tmpdir() is a symlink, and a symlinked baseDir makes the reported paths miss the ^src/ patterns.
  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "depcruise-")));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it.each(
    cases.map(
      ([rule, files], i) => [rule, Object.keys(files)[0], files, i] as const,
    ),
  )(
    "%s rejects a deliberate violation from %s",
    async (rule, _from, files, i) => {
      const dir = join(tmp, String(i));
      const all: Files = {
        ...files,
        "tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
        }),
      };
      for (const [path, body] of Object.entries(all)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), body);
      }
      // The API, unlike the CLI, reads tsconfig paths (the @/ alias) only from the parsed config passed separately.
      const tsConfigFile = join(dir, "tsconfig.json");
      const result = await cruise(
        ["src"],
        {
          ...config.options,
          tsConfig: { fileName: tsConfigFile },
          baseDir: dir,
          ruleSet: { forbidden: config.forbidden },
          validate: true,
        },
        {},
        { tsConfig: extractTSConfig(tsConfigFile) },
      );
      const output = result.output as {
        summary: { violations: { rule: { name: string } }[] };
      };
      expect(output.summary.violations.map((v) => v.rule.name)).toContain(rule);
    },
  );
});
