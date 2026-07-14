import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "@sapphi-red", "web-noise-suppressor", "dist");
const target = join(root, "client", "vendor", "noise-suppressor");

await mkdir(target, { recursive: true });
const workletSource = await readFile(join(source, "rnnoise", "workletProcessor.js"), "utf8");
const originalFrameProcessor =
  "let n=c.createDenoiseState(),e=m=>{Re(m),n.processFrame(m),be(m)},a=128";
const vadFrameProcessor =
  "let n=c.createDenoiseState(),v=0,h=0,e=m=>{Re(m);let r=n.processFrame(m);be(m),r>=.9?h=20:h>0&&h--;let o=r>=.9||h>0?1:0;for(let i=0;i<m.length;i++)v+=(o-v)*(o>v?.025:.0035),m[i]*=v},a=128";

if (!workletSource.includes(originalFrameProcessor)) {
  throw new Error("Unsupported web-noise-suppressor RNNoise worklet version");
}

await Promise.all([
  writeFile(
    join(target, "rnnoiseWorklet.js"),
    workletSource.replace(originalFrameProcessor, vadFrameProcessor),
    "utf8"
  ),
  copyFile(join(source, "rnnoise.wasm"), join(target, "rnnoise.wasm")),
  copyFile(join(source, "rnnoise_simd.wasm"), join(target, "rnnoise_simd.wasm"))
]);
