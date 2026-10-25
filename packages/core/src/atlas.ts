import { ATLAS_CELL, ATLAS_CELLS, type LeafShape } from "./look.ts";
import { createRng } from "./rng.ts";

/** The part of the Canvas 2D API that the painters use. Node and browsers both provide it. */
export type Paint2D = Pick<
  CanvasRenderingContext2D,
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "lineCap"
  | "save"
  | "restore"
  | "translate"
  | "rotate"
  | "scale"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "bezierCurveTo"
  | "arc"
  | "fill"
  | "stroke"
  | "createRadialGradient"
>;

const CELL = 128;
export const ATLAS_WIDTH = CELL * ATLAS_CELLS;
export const ATLAS_HEIGHT = CELL;

type Painter = (ctx: Paint2D) => void;

function paintBlossom(ctx: Paint2D): void {
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < 5; i++) {
    ctx.save();
    ctx.rotate((i / 5) * Math.PI * 2 - Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-30, -12, -30, -42, -8, -52);
    ctx.lineTo(0, -44);
    ctx.lineTo(8, -52);
    ctx.bezierCurveTo(30, -42, 30, -12, 0, 0);
    ctx.fill();
    ctx.restore();
  }
  const heart = ctx.createRadialGradient(0, 0, 0, 0, 0, 20);
  heart.addColorStop(0, "rgba(200,200,200,1)");
  heart.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = heart;
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fill();
}

function paintDab(ctx: Paint2D): void {
  const rng = createRng(99);
  ctx.rotate(-0.5);
  ctx.scale(1, 0.62);
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  const steps = 56;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r =
      54 * (1 + 0.14 * (0.5 * Math.sin(2 * a + 1.3) + (rng() - 0.5) * 0.6));
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r * 0.86;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(226,226,226,1)";
  ctx.lineCap = "round";
  for (let i = 0; i < 9; i++) {
    const y = -34 + 8.5 * i + (rng() - 0.5) * 4;
    ctx.lineWidth = 2 + 2.5 * rng();
    ctx.beginPath();
    ctx.moveTo(-40 + 14 * rng(), y);
    ctx.lineTo(34 - 14 * rng(), y + (rng() - 0.5) * 6);
    ctx.stroke();
  }
}

function paintLeaf(ctx: Paint2D): void {
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(0, 54);
  ctx.bezierCurveTo(-36, 20, -30, -30, 0, -58);
  ctx.bezierCurveTo(30, -30, 36, 20, 0, 54);
  ctx.fill();
  ctx.strokeStyle = "rgba(215,215,215,1)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 50);
  ctx.lineTo(0, -52);
  ctx.stroke();
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    ctx.moveTo(0, 12 * i);
    ctx.lineTo(-18, 12 * i - 12);
    ctx.moveTo(0, 12 * i);
    ctx.lineTo(18, 12 * i - 12);
    ctx.stroke();
  }
}

const PAINTERS: Record<LeafShape, Painter> = {
  blossom: paintBlossom,
  dab: paintDab,
  leaf: paintLeaf,
};

/** Paints the leaf shapes side by side into a context of {@link ATLAS_WIDTH} × {@link ATLAS_HEIGHT}. */
export function paintLeafAtlas(ctx: Paint2D): void {
  for (const [shape, cell] of Object.entries(ATLAS_CELL)) {
    ctx.save();
    ctx.translate(CELL * cell + CELL / 2, CELL / 2);
    PAINTERS[shape as LeafShape](ctx);
    ctx.restore();
  }
}
