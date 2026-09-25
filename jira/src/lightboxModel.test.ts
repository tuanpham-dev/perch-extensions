// The viewer's arithmetic. These are the rules a reader relies on without
// noticing: that a tall screenshot arrives whole, that zooming goes where you
// pointed, and that 1:1 really is one image pixel per screen pixel.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actualSize,
  clampScale,
  fitScale,
  fitted,
  isZoomed,
  panBy,
  step,
  toggleZoom,
  zoomAt,
} from "./lightboxModel.ts";

const VIEW = { width: 800, height: 600 };

test("a large image is fitted by whichever side runs out first", () => {
  assert.equal(fitScale({ width: 1600, height: 600 }, VIEW), 0.5, "width-bound");
  assert.equal(fitScale({ width: 800, height: 2400 }, VIEW), 0.25, "height-bound");
});

test("a small image is never blown up past its own size", () => {
  assert.equal(fitScale({ width: 100, height: 80 }, VIEW), 1);
});

test("a degenerate size does not produce a nonsense scale", () => {
  assert.equal(fitScale({ width: 0, height: 0 }, VIEW), 1);
  assert.equal(fitScale({ width: 100, height: 100 }, { width: 0, height: 0 }), 1);
});

test("an image opens fitted, centred, and not reading as zoomed", () => {
  const state = fitted({ width: 1600, height: 1200 }, VIEW);
  assert.deepEqual(state, { scale: 0.5, x: 0, y: 0, fit: 0.5 });
  assert.equal(isZoomed(state), false);
});

test("zoom is clamped to half the fit and to 8x", () => {
  assert.equal(clampScale(0.01, 0.5), 0.25);
  assert.equal(clampScale(99, 0.5), 8);
  assert.equal(clampScale(2, 0.5), 2);
});

test("zooming keeps whatever is under the pointer under the pointer", () => {
  const state = fitted({ width: 1600, height: 1200 }, VIEW);
  const pointer = { x: 120, y: -80 };
  const zoomed = zoomAt(state, 2, pointer);
  // The point's position in image space must not move: solving
  // (pointer - translate) / scale for both states gives the same value.
  const before = { x: (pointer.x - state.x) / state.scale, y: (pointer.y - state.y) / state.scale };
  const after = { x: (pointer.x - zoomed.x) / zoomed.scale, y: (pointer.y - zoomed.y) / zoomed.scale };
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
  assert.equal(zoomed.scale, 1);
});

test("zooming at the clamp does not drift the image", () => {
  const state = { scale: 8, x: 40, y: 20, fit: 0.5 };
  const zoomed = zoomAt(state, 2, { x: 100, y: 100 });
  assert.equal(zoomed.scale, 8);
  assert.deepEqual([zoomed.x, zoomed.y], [40, 20], "a refused zoom must not move it");
});

test("a scale a hair above fit is not treated as zoomed", () => {
  assert.equal(isZoomed({ scale: 0.505, x: 0, y: 0, fit: 0.5 }), false);
  assert.equal(isZoomed({ scale: 0.6, x: 0, y: 0, fit: 0.5 }), true);
});

test("clicking a fitted image goes to actual pixels; clicking a zoomed one refits", () => {
  const state = fitted({ width: 1600, height: 1200 }, VIEW);
  const zoomed = toggleZoom(state, { x: 0, y: 0 });
  assert.equal(zoomed.scale, 1, "1:1 - one image pixel per screen pixel");
  const back = toggleZoom(zoomed, { x: 0, y: 0 });
  assert.deepEqual(back, { scale: 0.5, x: 0, y: 0, fit: 0.5 });
});

test("actual size is 1:1 whatever the fit was", () => {
  assert.equal(actualSize(fitted({ width: 4000, height: 3000 }, VIEW)).scale, 1);
  assert.equal(actualSize(fitted({ width: 100, height: 100 }, VIEW)).scale, 1);
});

test("panning moves by exactly what it was given", () => {
  assert.deepEqual(panBy({ scale: 2, x: 10, y: 5, fit: 0.5 }, { x: -4, y: 7 }), { scale: 2, x: 6, y: 12, fit: 0.5 });
});

test("stepping wraps at both ends", () => {
  assert.equal(step(1, 1, 4), 2, "the ordinary case");
  assert.equal(step(3, 1, 4), 0, "off the end, round to the first");
  assert.equal(step(0, -1, 4), 3, "back off the start, round to the last");
  assert.equal(step(0, 1, 0), 0, "no shots at all");
  assert.equal(step(0, 1, 1), 0, "one shot is its own neighbour");
});

// JavaScript's % keeps the sign of the dividend, so a single modulo returns
// -1 here and indexes outside the array.
test("stepping back past the start never returns a negative index", () => {
  for (let count = 1; count <= 6; count++) {
    for (let index = 0; index < count; index++) {
      for (const delta of [-1, 1]) {
        const next = step(index, delta, count);
        assert.ok(next >= 0 && next < count, `step(${index}, ${delta}, ${count}) = ${next}`);
      }
    }
  }
});
