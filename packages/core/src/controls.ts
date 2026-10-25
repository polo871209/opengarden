import type { Season } from "./look.ts";

/**
 * The text and style of the season and new tree buttons. The web and terminal
 * hosts both draw them from these values, so the two look the same. Sizes are
 * CSS pixels.
 */
export const CONTROLS = {
  hint: "move through the leaves and they fall · click to drop many",
  newTree: "New tree",
  seasons: {
    spring: "Spring",
    summer: "Summer",
    autumn: "Autumn",
    winter: "Winter",
  } satisfies Record<Season, string>,
  ink: "#24222b",
  face: "#ffffff",
  hintFill: "#ffffffcc",
  font: "ui-monospace, SFMono-Regular, Menlo, monospace",
  /** Gap from the bottom of the view to the button row. */
  bottom: 14,
  /** Gap between the hint and the button row. */
  rowGap: 10,
  keyGap: 6,
  /** Extra gap before the new tree button. */
  spacer: 10,
  hintText: { size: 11, weight: 400, lineHeight: 1.4 },
  hintPadding: { x: 10, y: 5 },
  keyText: { size: 12, weight: 500 },
  keyPadding: { x: 13, y: 9 },
  keyBorder: 1.5,
  keyRadius: 8,
  /** Depth of the solid shadow under a button. */
  keyShadow: { rest: 2.5, hover: 3.5, pressed: 0.5 },
  /** Vertical move of a button, down is positive. */
  keyLift: { hover: -1, pressed: 2 },
} as const;
