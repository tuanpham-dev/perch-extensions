// How the remote picture sits in the tab: a base scale from the view mode
// (Fit, Fill, 100%), times the user's zoom, and a pan offset when the
// picture is larger than the stage. The single source for mapping page
// positions to remote pixels. Ported from quick-remote web/src/view.ts;
// here the stage is measured through callbacks (the viewer takes the
// phone keyboard's strip off the bottom) and the result is a box the
// React component applies to the canvas.
import type { ViewMode } from "./settings";

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Stage {
  /** The usable stage in CSS pixels. */
  size(): { width: number; height: number };
  /** Where the stage's top-left is on the page. */
  origin(): { left: number; top: number };
}

export class View {
  mode: ViewMode = "fit";
  /** Remote pixels per CSS pixel at 100% (the pixel ratio). */
  ratio = 1;
  zoom = 1;
  /** Pinch and Ctrl+wheel leave the zoom alone (the buttons still work). */
  zoomLocked = false;
  /** Top-left of the picture in stage coordinates (CSS px). */
  x = 0;
  y = 0;
  scale = 1;
  /** The remote picture's size in pixels. */
  picture = { width: 0, height: 0 };
  onChange: (box: Box) => void = () => {};

  constructor(private readonly stage: Stage) {}

  /** CSS pixels per remote pixel before zoom. */
  private base(): number {
    const { width: sw, height: sh } = this.stage.size();
    const cw = this.picture.width || 1;
    const ch = this.picture.height || 1;
    const fit = Math.min(sw / cw, sh / ch);
    const natural = 1 / this.ratio;
    // Fit shrinks a large picture but never enlarges past 100%.
    if (this.mode === "fit") return Math.min(fit, natural);
    if (this.mode === "fill") return fit;
    return natural;
  }

  /** Recomputes size and position (after a resize, a new picture size, a
   * mode or zoom change), keeping the pan within bounds. */
  layout(): Box {
    const { width: sw, height: sh } = this.stage.size();
    const prev = this.scale;
    this.scale = this.base() * this.zoom;
    const w = this.picture.width * this.scale;
    const h = this.picture.height * this.scale;
    if (prev !== this.scale && prev > 0) {
      // Keep the stage's centre on the same remote point.
      const cx = (sw / 2 - this.x) / prev;
      const cy = (sh / 2 - this.y) / prev;
      this.x = sw / 2 - cx * this.scale;
      this.y = sh / 2 - cy * this.scale;
    }
    this.x = w <= sw ? (sw - w) / 2 : Math.min(0, Math.max(sw - w, this.x));
    this.y = h <= sh ? (sh - h) / 2 : Math.min(0, Math.max(sh - h, this.y));
    const box = { left: this.x, top: this.y, width: w, height: h };
    this.onChange(box);
    return box;
  }

  /** Whether the picture is larger than the stage (it pans). */
  pans(): boolean {
    const { width: sw, height: sh } = this.stage.size();
    return this.picture.width * this.scale > sw + 0.5 || this.picture.height * this.scale > sh + 0.5;
  }

  setZoom(z: number, at?: [number, number]): void {
    const o = this.stage.origin();
    const { width: sw, height: sh } = this.stage.size();
    const [px, py] = at ? [at[0] - o.left, at[1] - o.top] : [sw / 2, sh / 2];
    // The remote point under `at` stays under it.
    const rx = (px - this.x) / this.scale;
    const ry = (py - this.y) / this.scale;
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
    const next = this.base() * this.zoom;
    this.x = px - rx * next;
    this.y = py - ry * next;
    this.scale = next;
    this.layout();
  }

  panBy(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.layout();
  }

  /** The stage on the page. */
  stageBox(): Box {
    const o = this.stage.origin();
    const s = this.stage.size();
    return { left: o.left, top: o.top, width: s.width, height: s.height };
  }

  /** The remote pixel under a page position, or null outside the picture. */
  toRemote(clientX: number, clientY: number): { x: number; y: number } | null {
    const o = this.stage.origin();
    const x = (clientX - o.left - this.x) / this.scale;
    const y = (clientY - o.top - this.y) / this.scale;
    if (x < 0 || y < 0 || x >= this.picture.width || y >= this.picture.height) return null;
    return { x: Math.floor(x), y: Math.floor(y) };
  }

  /** The nearest remote pixel to a page position (a drag that leaves the
   * picture keeps reporting its edge). */
  toRemoteClamped(clientX: number, clientY: number): { x: number; y: number } | null {
    if (this.picture.width === 0) return null;
    const o = this.stage.origin();
    const x = (clientX - o.left - this.x) / this.scale;
    const y = (clientY - o.top - this.y) / this.scale;
    return {
      x: Math.max(0, Math.min(this.picture.width - 1, Math.floor(x))),
      y: Math.max(0, Math.min(this.picture.height - 1, Math.floor(y))),
    };
  }
}
