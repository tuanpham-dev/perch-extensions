// Draws decoded VideoFrames on the viewer's canvas with a 2D context (the
// picture is one frame, no tiles: a display larger than the encoder takes
// is clamped by the host).

export class Renderer {
  private readonly ctx2d: CanvasRenderingContext2D | null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx2d = canvas.getContext("2d", { alpha: false, desynchronized: true });
  }

  get ready(): boolean {
    return this.ctx2d !== null;
  }

  setSize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  draw(frame: VideoFrame): void {
    try {
      this.ctx2d?.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    } finally {
      frame.close();
    }
  }
}
