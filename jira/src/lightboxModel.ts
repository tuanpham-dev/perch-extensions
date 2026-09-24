// The arithmetic behind the image viewer, kept away from the component so it
// can be checked by calling it rather than by dragging a picture around.
//
// Every number here matches `qa-report`'s own lightbox (the script that
// renders the HTML report): the same fit rule, the same clamps, the same
// 1.02 slack for "is this zoomed". That is deliberate - the panel and the
// report show the same screenshots, and a reader should not have to learn two
// sets of behaviour depending on which one they happen to have open.

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ViewState {
  scale: number;
  // Translation in viewport pixels, applied before the scale.
  x: number;
  y: number;
  // What "fit" is for the current image and viewport, kept alongside because
  // every clamp is relative to it.
  fit: number;
}

// Never bigger than 1: a small image centred at its own size is honest, where
// one blown up to fill the pane invents detail that is not there.
export function fitScale(natural: Size, viewport: Size): number {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  return Math.min(viewport.width / natural.width, viewport.height / natural.height, 1);
}

export function fitted(natural: Size, viewport: Size): ViewState {
  const fit = fitScale(natural, viewport);
  return { scale: fit, x: 0, y: 0, fit };
}

// Half the fit at the low end so a fitted image can still be pulled back a
// little, 8x at the top - past that a screenshot is just pixels.
export function clampScale(scale: number, fit: number): number {
  return Math.min(Math.max(scale, fit * 0.5), 8);
}

// Zoom about a point, keeping whatever is under it where it is. `pointer` is
// relative to the viewport's centre, which is where the transform's origin
// sits - the component converts from client coordinates once, so this stays
// free of element geometry.
export function zoomAt(state: ViewState, factor: number, pointer: Point): ViewState {
  const next = clampScale(state.scale * factor, state.fit);
  const ratio = next / state.scale;
  if (!Number.isFinite(ratio) || ratio === 1) return { ...state, scale: next };
  return {
    scale: next,
    x: pointer.x - (pointer.x - state.x) * ratio,
    y: pointer.y - (pointer.y - state.y) * ratio,
    fit: state.fit,
  };
}

export function panBy(state: ViewState, delta: Point): ViewState {
  return { ...state, x: state.x + delta.x, y: state.y + delta.y };
}

// A little slack, so a scale a rounding error above fit does not read as
// zoomed and flip the cursor and the click behaviour.
export function isZoomed(state: ViewState): boolean {
  return state.scale > state.fit * 1.02;
}

// Clicking a zoomed image fits it; clicking a fitted one goes to actual
// pixels, about the point clicked.
export function toggleZoom(state: ViewState, pointer: Point): ViewState {
  if (isZoomed(state)) return { scale: state.fit, x: 0, y: 0, fit: state.fit };
  return zoomAt(state, 1 / state.scale, pointer);
}

export function actualSize(state: ViewState, pointer: Point = { x: 0, y: 0 }): ViewState {
  return zoomAt(state, 1 / state.scale, pointer);
}

// Stops at the ends rather than wrapping: walking off the last shot and
// landing back on the first is disorienting when you are comparing two.
export function step(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index + delta, 0), count - 1);
}
