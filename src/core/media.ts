/** Only explicitly attached, ordinary raster files may render automatically. */
export function localImagePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !/[\\:?#%\p{Cc}]/u.test(path)
    && !path.startsWith("/") && !path.split("/").some(part => part.startsWith(".") || !part)
    && /\.(?:png|jpe?g|webp|gif)$/i.test(path);
}
export function imageDimensionsAllowed(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && width <= 16384 && height <= 16384 && width * height <= 40000000;
}
