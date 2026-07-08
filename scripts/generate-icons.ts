import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const iconsDir = path.resolve("src/public/icons");
const iconSvg = fs.readFileSync(path.join(iconsDir, "icon.svg"));
const maskableSvg = fs.readFileSync(path.join(iconsDir, "icon-maskable.svg"));

const jobs: Array<[string, Buffer, number]> = [
  ["icon-192.png", iconSvg, 192],
  ["icon-512.png", iconSvg, 512],
  ["icon-maskable-192.png", maskableSvg, 192],
  ["icon-maskable-512.png", maskableSvg, 512],
  ["apple-touch-icon.png", iconSvg, 180],
];

for (const [name, svg, size] of jobs) {
  await sharp(svg).resize(size, size).png().toFile(path.join(iconsDir, name));
  console.log(`已生成 ${name}`);
}
