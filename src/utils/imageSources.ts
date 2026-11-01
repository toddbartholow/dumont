/**
 * Which `data:` image URLs the reader displays.
 *
 * Raster types only. An SVG is a document that can carry script and remote
 * references; inside an <img> the browser does not run either, but an SVG
 * data URL is also the classic way to smuggle markup past a filter, and
 * nothing a person embeds as base64 needs it. PNG, JPEG, GIF, WebP, BMP and
 * AVIF cover what screenshot tools and converters write.
 */
const RASTER_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp|avif)[;,]/i;

export function isRasterDataImage(url: string): boolean {
    return RASTER_DATA_IMAGE.test(url.trim());
}
