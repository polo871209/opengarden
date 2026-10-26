import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { BLOCK, type Capture } from "./capture.ts";
import type { TerminalSize } from "./terminal.ts";

const ESC = "\x1b";
const IMAGE_ID = 1;
const OVERLAY_ID = 2;
const COMMAND_COST = 12;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface KittyFrame {
  /** Graphics commands. The caller wraps them in a synchronized update. */
  sequence: string;
  bytes: number;
  edits: number;
}

export interface KittyScreen {
  /** Returns the size in pixels to render at `detail` pixels per screen pixel. */
  layout(size: TerminalSize, detail: number): { width: number; height: number };
  /**
   * Writes the changed pixels, or every pixel if `full`, to a file that the
   * commands point at. The file is reused, so the terminal must finish a
   * frame before the next present.
   */
  present(capture: Capture, full: boolean): KittyFrame;
  overlay(png: Buffer, x: number, y: number): string;
  clear(): string;
  dispose(): void;
}

const command = (keys: string, path: string) =>
  `${ESC}_G${keys};${Buffer.from(path).toString("base64")}${ESC}\\`;

function rowRuns(dirty: Uint32Array, row: number, columns: number) {
  const runs: { x: number; width: number }[] = [];
  const start = row * columns;
  let last: { x: number; width: number } | undefined;
  for (let x = 0; x < columns; x++) {
    if (!dirty[start + x]) continue;
    if (last && x - (last.x + last.width) <= COMMAND_COST)
      last.width = x + 1 - last.x;
    else {
      last = { x, width: 1 };
      runs.push(last);
    }
  }
  return runs;
}

const joinCost = (rect: Rect, run: { x: number; width: number }) => {
  const width =
    Math.max(rect.x + rect.width, run.x + run.width) - Math.min(rect.x, run.x);
  return (width - rect.width) * rect.height + (width - run.width);
};

function coverChanges(
  dirty: Uint32Array,
  columns: number,
  rows: number,
): Rect[] {
  const rects: Rect[] = [];
  let above: Rect[] = [];
  for (let y = 0; y < rows; y++) {
    const growing: Rect[] = [];
    for (const run of rowRuns(dirty, y, columns)) {
      const index = above.findIndex(
        (rect) => joinCost(rect, run) <= COMMAND_COST,
      );
      if (index < 0) {
        const rect = { x: run.x, y, width: run.width, height: 1 };
        rects.push(rect);
        growing.push(rect);
        continue;
      }
      const [rect] = above.splice(index, 1);
      const right = Math.max(rect.x + rect.width, run.x + run.width);
      rect.x = Math.min(rect.x, run.x);
      rect.width = right - rect.x;
      rect.height++;
      growing.push(rect);
    }
    above = growing;
  }
  return rects;
}

/**
 * Shows frames as one Kitty image that covers the terminal. A redraw sends the
 * whole image (`a=T`). Other frames edit the changed rectangles in place
 * (`a=f`), even when the whole view changes, because Rex drops most frames
 * when each one is a new image, for example while the view spins. Pixels
 * travel in a file (`t=f`) that the terminal reads at an offset (`O`, `S`), so
 * the escape codes stay small.
 */
export function createKittyScreen(): KittyScreen {
  const directory = mkdtempSync("/tmp/opengarden-");
  const framePath = join(directory, "frame");
  const overlayPath = join(directory, "overlay");
  const frameFile = openSync(framePath, "w+");
  let staging = Buffer.alloc(0);
  let placement = "";
  let cell = { width: 1, height: 1 };

  const sendWhole = (capture: Capture): KittyFrame => {
    const bytes = capture.rgb.length;
    writeSync(frameFile, capture.rgb, 0, bytes, 0);
    return {
      sequence:
        `${ESC}[1;1H` +
        command(
          `a=T,i=${IMAGE_ID},p=1,${placement},C=1,f=24,s=${capture.width},v=${capture.height},t=f,S=${bytes},q=1`,
          framePath,
        ),
      bytes,
      edits: 1,
    };
  };

  return {
    layout(size, detail) {
      cell = { width: size.cellWidth, height: size.cellHeight };
      const width = Math.floor(size.columns * size.cellWidth * detail);
      const height = Math.floor(size.rows * size.cellHeight * detail);
      placement = `c=${size.columns},r=${size.rows}`;
      staging = Buffer.alloc(width * height * 3);
      return { width, height };
    },

    present(capture, full) {
      if (full) return sendWhole(capture);
      const rects = coverChanges(capture.dirty, capture.columns, capture.rows);
      let offset = 0;
      let sequence = "";
      for (const rect of rects) {
        const x = rect.x * BLOCK;
        const y = rect.y * BLOCK;
        const width =
          Math.min(capture.width, (rect.x + rect.width) * BLOCK) - x;
        const height =
          Math.min(capture.height, (rect.y + rect.height) * BLOCK) - y;
        const rowBytes = width * 3;
        for (let row = 0; row < height; row++) {
          const from = ((y + row) * capture.width + x) * 3;
          staging.set(
            capture.rgb.subarray(from, from + rowBytes),
            offset + row * rowBytes,
          );
        }
        const bytes = rowBytes * height;
        sequence += command(
          `a=f,i=${IMAGE_ID},r=1,X=1,x=${x},y=${y},s=${width},v=${height},f=24,t=f,O=${offset},S=${bytes},q=1`,
          framePath,
        );
        offset += bytes;
      }
      if (rects.length) writeSync(frameFile, staging, 0, offset, 0);
      return { sequence, bytes: offset, edits: rects.length };
    },

    overlay(png, x, y) {
      const column = Math.floor(x / cell.width);
      const row = Math.floor(y / cell.height);
      writeFileSync(overlayPath, png);
      return (
        `${ESC}[${row + 1};${column + 1}H` +
        command(
          `a=T,i=${OVERLAY_ID},p=1,C=1,z=1,f=100,t=f,X=${x - column * cell.width},Y=${y - row * cell.height},q=1`,
          overlayPath,
        )
      );
    },

    clear() {
      return `${ESC}_Ga=d,d=A,q=2${ESC}\\`;
    },

    dispose() {
      closeSync(frameFile);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
