import { existsSync } from "node:fs";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { CONTROLS as C, SEASONS, type Season } from "@opengardenjs/core";

const SYSTEM_MONO = "/System/Library/Fonts/SFNSMono.ttf";
const MARGIN = 6;

export type ControlAction =
  | { type: "season"; season: Season }
  | { type: "new-tree" };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Key extends Box {
  label: string;
  action: ControlAction;
}

/** An image of the controls, and its top left corner in CSS pixels. */
interface ControlsImage {
  png: Buffer;
  x: number;
  y: number;
}

/**
 * The season and new tree buttons that the browser shows as HTML, painted
 * for the terminal and hit tested in CSS pixels.
 */
export interface Controls {
  layout(width: number, height: number): void;
  select(season: Season): void;
  /** True if the pointer is over a button. */
  over(x: number, y: number): boolean;
  /** Returns true if the image changed. */
  hover(x: number, y: number): boolean;
  /** Returns true if the image changed. */
  press(x: number, y: number): boolean;
  /** Returns the action of the button that was pressed and released. */
  release(x: number, y: number): ControlAction | undefined;
  paint(scale: number): ControlsImage;
}

const inside = (box: Box, x: number, y: number) =>
  x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;

function roundRect(ctx: SKRSContext2D, box: Box, radius: number) {
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.width, box.height, radius);
}

export function createControls(season: Season): Controls {
  if (existsSync(SYSTEM_MONO) && !GlobalFonts.has("ui-monospace"))
    GlobalFonts.registerFromPath(SYSTEM_MONO, "ui-monospace");
  const measure = createCanvas(1, 1).getContext("2d");
  const textWidth = (font: string, text: string) => {
    measure.font = font;
    return measure.measureText(text).width;
  };
  const hintFont = `${C.hintText.weight} ${C.hintText.size}px ${C.font}`;
  const keyFont = `${C.keyText.weight} ${C.keyText.size}px ${C.font}`;

  let selected = season;
  let hint: Box = { x: 0, y: 0, width: 0, height: 0 };
  let keys: Key[] = [];
  let bounds: Box = hint;
  let hovered: Key | undefined;
  let pressed: Key | undefined;

  const keyAt = (x: number, y: number) => keys.find((key) => inside(key, x, y));

  return {
    layout(width, height) {
      const entries: { label: string; action: ControlAction }[] = [
        ...SEASONS.map((value) => ({
          label: C.seasons[value],
          action: { type: "season", season: value } as const,
        })),
        { label: C.newTree, action: { type: "new-tree" } },
      ];
      const keyHeight = C.keyText.size + 2 * C.keyPadding.y + 2 * C.keyBorder;
      const widths = entries.map(
        (entry) =>
          textWidth(keyFont, entry.label) +
          2 * C.keyPadding.x +
          2 * C.keyBorder,
      );
      const rowWidth =
        widths.reduce((sum, w) => sum + w, 0) +
        C.keyGap * entries.length +
        C.spacer;
      const rowY = height - C.bottom - keyHeight;
      let x = (width - rowWidth) / 2;
      keys = entries.map((entry, i) => {
        if (entry.action.type === "new-tree") x += C.spacer + C.keyGap;
        const key = {
          ...entry,
          x,
          y: rowY,
          width: widths[i],
          height: keyHeight,
        };
        x += widths[i] + C.keyGap;
        return key;
      });
      const hintWidth = textWidth(hintFont, C.hint) + 2 * C.hintPadding.x;
      const hintHeight =
        C.hintText.size * C.hintText.lineHeight + 2 * C.hintPadding.y;
      hint = {
        x: (width - hintWidth) / 2,
        y: rowY - C.rowGap - hintHeight,
        width: hintWidth,
        height: hintHeight,
      };
      const left = Math.min(hint.x, keys[0].x);
      const right = Math.max(hint.x + hint.width, x - C.keyGap);
      bounds = {
        x: left,
        y: hint.y,
        width: right - left,
        height: rowY + keyHeight - hint.y,
      };
      hovered = undefined;
      pressed = undefined;
    },

    select(value) {
      selected = value;
    },

    over: (x, y) => keyAt(x, y) !== undefined,

    hover(x, y) {
      const key = keyAt(x, y);
      if (key === hovered) return false;
      hovered = key;
      return true;
    },

    press(x, y) {
      pressed = keyAt(x, y);
      return pressed !== undefined;
    },

    release(x, y) {
      const key = pressed;
      pressed = undefined;
      return key && key === keyAt(x, y) ? key.action : undefined;
    },

    paint(scale) {
      const left = Math.max(0, Math.floor(bounds.x - MARGIN));
      const top = Math.max(0, Math.floor(bounds.y - MARGIN));
      const width = Math.ceil(bounds.x + bounds.width + MARGIN) - left;
      const height = Math.ceil(bounds.y + bounds.height + MARGIN) - top;
      const canvas = createCanvas(
        Math.ceil(width * scale),
        Math.ceil(height * scale),
      );
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.translate(-left, -top);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      roundRect(ctx, hint, hint.height / 2);
      ctx.fillStyle = C.hintFill;
      ctx.fill();
      ctx.fillStyle = C.ink;
      ctx.font = hintFont;
      ctx.fillText(C.hint, hint.x + hint.width / 2, hint.y + hint.height / 2);

      ctx.font = keyFont;
      const inset = C.keyBorder / 2;
      for (const key of keys) {
        const on =
          key.action.type === "season" && key.action.season === selected;
        const state =
          key === pressed ? "pressed" : key === hovered ? "hover" : "rest";
        const lift = state === "rest" ? 0 : C.keyLift[state];
        const box = { ...key, y: key.y + lift };
        roundRect(ctx, { ...box, y: box.y + C.keyShadow[state] }, C.keyRadius);
        ctx.fillStyle = C.ink;
        ctx.fill();
        roundRect(ctx, box, C.keyRadius);
        ctx.fillStyle = on ? C.ink : C.face;
        ctx.fill();
        roundRect(
          ctx,
          {
            x: box.x + inset,
            y: box.y + inset,
            width: box.width - C.keyBorder,
            height: box.height - C.keyBorder,
          },
          C.keyRadius - inset,
        );
        ctx.lineWidth = C.keyBorder;
        ctx.strokeStyle = C.ink;
        ctx.stroke();
        ctx.fillStyle = on ? C.face : C.ink;
        ctx.fillText(key.label, box.x + box.width / 2, box.y + box.height / 2);
      }
      return { png: canvas.toBuffer("image/png"), x: left, y: top };
    },
  };
}
