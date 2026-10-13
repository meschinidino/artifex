/** Generate a 1010-file corpus (800 TS + 210 Python incl. __init__) for D14 RSS baselines. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "/tmp/artifex-spike/corpus1000";
mkdirSync(root, { recursive: true });

for (let d = 0; d < 40; d++) {
  const dir = join(root, `pkg${d}`);
  mkdirSync(dir, { recursive: true });
  for (let f = 0; f < 20; f++) {
    const prev = f > 0 ? `import { fn${f - 1} } from "./mod${f - 1}";\n` : "";
    let body = `${prev}export function fn${f}(x: number): number {\n  return x + ${f};\n}\n`;
    for (let k = 0; k < 12; k++) {
      body += `export const v${f}_${k} = fn${f}(${k}) * 2; // value ${k} in module ${f} of package ${d}\n`;
    }
    writeFileSync(join(dir, `mod${f}.ts`), body);
  }
}
for (let d = 0; d < 10; d++) {
  const dir = join(root, `pypkg${d}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "__init__.py"), "");
  for (let f = 0; f < 20; f++) {
    const prev = f > 0 ? `from .mod${f - 1} import fn${f - 1}\n` : "";
    let body = `${prev}def fn${f}(x):\n    return x + ${f}\n\n`;
    for (let k = 0; k < 12; k++) {
      body += `v${f}_${k} = fn${f}(${k}) * 2  # value ${k} in module ${f} of package ${d}\n`;
    }
    writeFileSync(join(dir, `mod${f}.py`), body);
  }
}
console.log("corpus listo en", root);
