import sharp from "sharp";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const output = new URL("../public/pwa/", import.meta.url);
await mkdir(output, { recursive: true });
const svg = await readFile(new URL("../public/booking-and-more-mark.svg", import.meta.url));
for (const size of [192, 512, 180]) {
  const name = size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`;
  await sharp(svg)
    .resize(size, size)
    .flatten({ background: "#ffffff" })
    .png()
    .toFile(fileURLToPath(new URL(name, output)));
}
// The entire mark fits inside the central 80% safe circle of a maskable icon.
const mark = await sharp(svg).resize(280, 280).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: "#1f5cd4" } })
  .composite([{ input: mark, gravity: "centre" }])
  .png()
  .toFile(fileURLToPath(new URL("icon-maskable-512.png", output)));
