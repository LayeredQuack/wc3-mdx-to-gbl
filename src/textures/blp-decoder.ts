/**
 * Decode a Warcraft III BLP texture and encode its first mip level as PNG.
 *
 * Keep this helper separate from texture path resolution: resolution only
 * finds the source file; this function produces the PNG image bytes that
 * glTF Transform embeds.
 */

import * as fs from 'fs';
import { decodeBLP, getBLPImageData } from 'war3-model';
import { PNG } from 'pngjs';

export function blpToPngBuffer(blpPath: string): Buffer {
  const raw = fs.readFileSync(blpPath);
  const arrayBuffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength
  );
  const blp = decodeBLP(arrayBuffer);
  const image = getBLPImageData(blp, 0);

  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`BLP decoder returned invalid dimensions ${width}x${height}`);
  }

  const expectedBytes = width * height * 4;
  if (!image.data || image.data.length !== expectedBytes) {
    throw new Error(
      `BLP decoder returned ${image.data?.length ?? 0} pixel bytes; expected ${expectedBytes} RGBA bytes for ${width}x${height}`
    );
  }

  const png = new PNG({ width, height });
  for (let i = 0; i < expectedBytes; i++) {
    png.data[i] = image.data[i];
  }
  return PNG.sync.write(png);
}
