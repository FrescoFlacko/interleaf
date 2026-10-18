/**
 * A complete 2D canvas context for jsdom.
 *
 * jsdom has no canvas implementation, so `getContext('2d')` returns `null` and
 * the PDF renderer refuses to paint. These specs are about the reader's own
 * scheduling, geometry and text-layer behavior, not about pixels, so they need
 * a context that answers every call without drawing anything. This implements
 * the whole `CanvasRenderingContext2D` contract: state properties are real and
 * readable back after a write, the measurement calls return fixed geometry, and
 * the drawing calls record nothing.
 */
export class TestCanvasContext implements CanvasRenderingContext2D {
  readonly canvas: HTMLCanvasElement;

  globalAlpha = 1;
  globalCompositeOperation: GlobalCompositeOperation = 'source-over';
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000000';
  filter = 'none';
  imageSmoothingEnabled = true;
  imageSmoothingQuality: ImageSmoothingQuality = 'low';
  lineCap: CanvasLineCap = 'butt';
  lineDashOffset = 0;
  lineJoin: CanvasLineJoin = 'miter';
  lineWidth = 1;
  miterLimit = 10;
  shadowBlur = 0;
  shadowColor = 'rgba(0, 0, 0, 0)';
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  direction: CanvasDirection = 'ltr';
  font = '10px sans-serif';
  fontKerning: CanvasFontKerning = 'auto';
  fontStretch: CanvasFontStretch = 'normal';
  fontVariantCaps: CanvasFontVariantCaps = 'normal';
  letterSpacing = '0px';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  textRendering: CanvasTextRendering = 'auto';
  wordSpacing = '0px';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  // Drawing, path and transform calls: accepted and discarded.
  drawImage(): void { /* nothing is painted in jsdom */ }
  beginPath(): void { /* no path state is kept */ }
  clip(): void { /* no path state is kept */ }
  fill(): void { /* nothing is painted in jsdom */ }
  stroke(): void { /* nothing is painted in jsdom */ }
  arc(): void { /* no path state is kept */ }
  arcTo(): void { /* no path state is kept */ }
  bezierCurveTo(): void { /* no path state is kept */ }
  closePath(): void { /* no path state is kept */ }
  ellipse(): void { /* no path state is kept */ }
  lineTo(): void { /* no path state is kept */ }
  moveTo(): void { /* no path state is kept */ }
  quadraticCurveTo(): void { /* no path state is kept */ }
  rect(): void { /* no path state is kept */ }
  roundRect(): void { /* no path state is kept */ }
  clearRect(): void { /* nothing is painted in jsdom */ }
  fillRect(): void { /* nothing is painted in jsdom */ }
  strokeRect(): void { /* nothing is painted in jsdom */ }
  fillText(): void { /* nothing is painted in jsdom */ }
  strokeText(): void { /* nothing is painted in jsdom */ }
  putImageData(): void { /* nothing is painted in jsdom */ }
  drawFocusIfNeeded(): void { /* jsdom owns focus rings */ }
  resetTransform(): void { /* the transform is always the identity */ }
  rotate(): void { /* the transform is always the identity */ }
  scale(): void { /* the transform is always the identity */ }
  setTransform(): void { /* the transform is always the identity */ }
  transform(): void { /* the transform is always the identity */ }
  translate(): void { /* the transform is always the identity */ }
  save(): void { /* state is never stacked */ }
  restore(): void { /* state is never stacked */ }
  reset(): void { /* state is never stacked */ }

  isContextLost(): boolean { return false; }
  isPointInPath(): boolean { return false; }
  isPointInStroke(): boolean { return false; }
  getLineDash(): number[] { return []; }
  setLineDash(): void { /* dashes are not painted */ }
  getTransform(): DOMMatrix { return new DOMMatrix(); }

  getContextAttributes(): CanvasRenderingContext2DSettings {
    return { alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: false };
  }

  /**
   * Fixed glyph geometry. The width is deliberately constant rather than
   * proportional to the string: the text layer scales each run by the ratio of
   * its measured width to the width PDF.js recorded, and a constant keeps that
   * ratio stable across the strings a test happens to use.
   */
  measureText(): TextMetrics {
    return {
      width: 10,
      actualBoundingBoxAscent: 10,
      actualBoundingBoxDescent: 2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 10,
      alphabeticBaseline: 0,
      emHeightAscent: 10,
      emHeightDescent: 2,
      fontBoundingBoxAscent: 10,
      fontBoundingBoxDescent: 2,
      hangingBaseline: 8,
      ideographicBaseline: -2,
    };
  }

  createImageData(): ImageData { return emptyImageData(); }
  getImageData(): ImageData { return emptyImageData(); }
  createPattern(): CanvasPattern | null { return null; }
  createConicGradient(): CanvasGradient { return emptyGradient(); }
  createLinearGradient(): CanvasGradient { return emptyGradient(); }
  createRadialGradient(): CanvasGradient { return emptyGradient(); }
}

function emptyImageData(): ImageData {
  return { data: new Uint8ClampedArray(4), width: 1, height: 1, colorSpace: 'srgb' };
}

function emptyGradient(): CanvasGradient {
  return { addColorStop: () => undefined };
}
