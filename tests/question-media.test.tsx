import assert from "node:assert/strict";
import test from "node:test";
import { localImagePath, imageDimensionsAllowed } from "../src/ui/shared";

test("automatic question images are limited to ordinary relative raster paths", () => {
  for (const path of ["attachments/diagram.png", "Study notes/image 2.JPG", "图表.webp"]) assert.equal(localImagePath(path), true, path);
  for (const path of ["https://tracker.invalid/a.png", "//host/a.png", "/outside.png", "../secret.png", "images/../secret.png", "images/./image.png", "images//image.png", "images/%2e%2e/a.png", "file:a.png", "a.svg", "a.png?url=x", "a.png#x", "a\\b.png", "a\n.png"]) assert.equal(localImagePath(path), false, path);
});

test("question images reject invalid or oversized decoded dimensions", () => {
  assert.equal(imageDimensionsAllowed(1920, 1080), true);
  assert.equal(imageDimensionsAllowed(8000, 5000), true);
  for (const [width, height] of [[0, 100], [100, -1], [NaN, 10], [Infinity, 10], [1.5, 100], [16385, 1], [8000, 5001]]) {
    assert.equal(imageDimensionsAllowed(width, height), false);
  }
});
