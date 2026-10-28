/**
 * Turns a cover image into an 8th Wall image target (flat / PLANAR), the same files the official
 * `@8thwall/image-target-cli` writes: a 3:4 crop, a grayscale tracking image, a thumbnail and the target JSON.
 * The CLI itself is interactive-only, so this re-does its (small) flat-image path with sharp.
 *
 * Only JPEG and PNG are accepted: sharp's bundled libheif / librsvg have open advisories, and covers are always JPEG or PNG anyway.
 * `sharp` is imported lazily so the rest of the Lambda (and its tests) load without it.
 */
import { HttpError } from "./validate.mjs";

export const TARGET = { minWidth: 480, minHeight: 640, thumbHeight: 350, luminanceHeight: 640, maxPixels: 40_000_000, quality: 85 };

/** The CLI's default crop: the largest centered 3:4 portrait region. Same maths as `getDefaultCrop(metadata, false)`. */
export function defaultCrop(width, height) {
  if (width / 3 > height / 4) {
    const w = Math.round((height * 3) / 4);
    return { left: Math.round((width - w) / 2), top: 0, width: w, height };
  }
  const h = Math.round((width * 4) / 3);
  return { left: 0, top: Math.round((height - h) / 2), width, height: h };
}

/** Problems with a crop box on an image, in plain words (empty when it is fine). */
export function cropProblems(crop, width, height) {
  const issues = [];
  const { left, top, width: w, height: h } = crop;
  if ([left, top, w, h].some((n) => !Number.isInteger(n))) return ["the crop must be whole numbers: left, top, width, height"];
  if (left < 0 || top < 0) issues.push("the crop starts outside the image");
  if (w < TARGET.minWidth) issues.push(`the crop is too narrow (at least ${TARGET.minWidth} px wide)`);
  if (h < TARGET.minHeight) issues.push(`the crop is too short (at least ${TARGET.minHeight} px tall)`);
  if (left + w > width || top + h > height) issues.push("the crop goes past the edge of the image");
  return issues;
}

/**
 * @param {{ buffer: Buffer, name: string, crop?: {left:number,top:number,width:number,height:number} }} input
 * @returns {Promise<{ json: object, files: { luminance: Buffer, thumbnail: Buffer, cropped: Buffer }, crop: object, source: {width:number,height:number,format:string} }>}
 */
export async function compileTarget({ buffer, name, crop }) {
  const sharp = (await import("sharp")).default;
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: TARGET.maxPixels }).metadata();
  } catch {
    throw new HttpError(422, "that file is not a readable image (or it is too large)");
  }
  if (!["jpeg", "png"].includes(meta.format)) throw new HttpError(422, "covers must be JPEG or PNG images");
  // EXIF orientations 5-8 mean the picture is stored sideways; every size below is of the upright picture.
  const sideways = (meta.orientation || 1) >= 5;
  const width = sideways ? meta.height : meta.width;
  const height = sideways ? meta.width : meta.height;
  if (!width || !height || width < TARGET.minWidth || height < TARGET.minHeight) {
    throw new HttpError(422, `the image is too small: ${width}×${height}. A cover needs at least ${TARGET.minWidth}×${TARGET.minHeight} pixels, bigger tracks better`);
  }
  const box = crop || defaultCrop(width, height);
  const issues = cropProblems(box, width, height);
  if (issues.length) throw new HttpError(422, issues.join("; "));

  // `.rotate()` applies any EXIF orientation first, so phone photos come out upright.
  const upright = () => sharp(buffer, { limitInputPixels: TARGET.maxPixels }).rotate();
  const cropped = upright().extract(box);
  const jpeg = { quality: TARGET.quality };
  const [croppedBuf, thumbBuf, lumBuf] = await Promise.all([
    cropped.clone().jpeg(jpeg).toBuffer(),
    cropped.clone().resize({ height: TARGET.thumbHeight }).jpeg(jpeg).toBuffer(),
    cropped.clone().resize({ height: TARGET.luminanceHeight }).grayscale().jpeg(jpeg).toBuffer()
  ]);

  const stamp = Date.now();
  const json = {
    imagePath: `image-targets/${name}_luminance.jpg`,
    metadata: null,
    name,
    type: "PLANAR",
    properties: { ...box, isRotated: false, originalWidth: width, originalHeight: height },
    resources: {
      originalImage: `${name}_original.${meta.format === "jpeg" ? "jpg" : "png"}`,
      croppedImage: `${name}_cropped.jpg`,
      thumbnailImage: `${name}_thumbnail.jpg`,
      luminanceImage: `${name}_luminance.jpg`
    },
    created: stamp,
    updated: stamp
  };
  return { json, files: { luminance: lumBuf, thumbnail: thumbBuf, cropped: croppedBuf }, crop: box, source: { width, height, format: meta.format } };
}
