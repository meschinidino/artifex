/**
 * T7 compress-fallback warming: self-contained proof that the pivot demo
 * (make-your-own-ilovepdf compress) works headless. Generates a noisy
 * PostScript fixture, distills it big (/prepress), compresses it small
 * (/ebook), and verifies same pages + fewer bytes. No binaries in git:
 * the fixture is rebuilt deterministically on every run.
 *
 * Usage: bun run spike/compress-proof.ts
 * Requires: ghostscript (`gs`) on PATH.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CompressProof = {
  schema: "toaster-compress-0";
  stub: false;
  ranAt: string;
  pagesIn: number;
  pagesOut: number;
  inBytes: number;
  outBytes: number;
  ratio: number;
  ok: boolean;
};

/** Deterministic PRNG so the fixture is stable run to run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Noisy RGB page: compresses poorly on purpose (worst case in). */
function fixturePs(width: number, height: number): string {
  const rand = mulberry32(20261023);
  const px = width * height;
  const hex = new Array<string>(px);
  for (let i = 0; i < px; i++) {
    const r = Math.floor(rand() * 256);
    const g = Math.floor((i / px) * 255);
    const b = Math.floor(rand() * 256);
    hex[i] =
      r.toString(16).padStart(2, "0") +
      g.toString(16).padStart(2, "0") +
      b.toString(16).padStart(2, "0");
  }
  return [
    "%!PS-Adobe-3.0",
    "<< /PageSize [612 792] >> setpagedevice",
    `/pic <${hex.join("")}> def`,
    `gsave 22 22 568 600 rectclip 22 22 translate 568 600 scale`,
    `${width} ${height} 8 [${width} 0 0 ${-height} 0 ${height}] { pic } false 3 colorimage`,
    "grestore",
    "/Helvetica findfont 18 scalefont setfont 72 720 moveto",
    "(Toaster compress fallback fixture) show",
    "showpage",
  ].join("\n");
}

function gs(args: string[]): void {
  execFileSync("gs", args, { stdio: "pipe" });
}

function pageCount(dir: string, pdf: string): number {
  const out = execFileSync(
    "gs",
    [
      "-dNODISPLAY",
      `--permit-file-read=${dir}/`,
      "-c",
      `(${pdf}) (r) file runpdfbegin pdfpagecount = quit`,
    ],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  const m = out.match(/(\d+)\s*$/m);
  if (!m) throw new Error(`pageCount: no count in gs output for ${pdf}`);
  return Number(m[1]);
}

function run(): CompressProof {
  const dir = mkdtempSync(join(tmpdir(), "toaster-compress-"));
  try {
    const ps = join(dir, "fixture.ps");
    const big = join(dir, "fixture.pdf");
    const small = join(dir, "compressed.pdf");
    writeFileSync(ps, fixturePs(800, 1000));
    gs([
      "-dBATCH",
      "-dNOPAUSE",
      "-sDEVICE=pdfwrite",
      "-dPDFSETTINGS=/prepress",
      `-sOutputFile=${big}`,
      ps,
    ]);
    gs([
      "-dBATCH",
      "-dNOPAUSE",
      "-sDEVICE=pdfwrite",
      "-dPDFSETTINGS=/ebook",
      `-sOutputFile=${small}`,
      big,
    ]);
    const inBytes = statSync(big).size;
    const outBytes = statSync(small).size;
    const pagesIn = pageCount(dir, big);
    const pagesOut = pageCount(dir, small);
    const ok = pagesIn > 0 && pagesIn === pagesOut && outBytes < inBytes;
    return {
      schema: "toaster-compress-0",
      stub: false,
      ranAt: new Date().toISOString(),
      pagesIn,
      pagesOut,
      inBytes,
      outBytes,
      ratio: outBytes / inBytes,
      ok,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const proof = run();
console.log(JSON.stringify(proof));
console.log(
  `pages ${proof.pagesIn}→${proof.pagesOut}, bytes ${proof.inBytes}→${proof.outBytes} (${(proof.ratio * 100).toFixed(1)}%), ok=${proof.ok}`,
);
if (!proof.ok) process.exit(1);
