import { CONTROLS, SEASONS, type Season } from "@opengardenjs/core";

export interface Controls {
  select(season: Season): void;
}

const STYLE_ID = "opengarden-style";
const C = CONTROLS;

const STYLE = `
.og-garden {
  position: relative;
  width: 100%;
  height: 100%;
}

.og-garden canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}

.og-ui {
  position: absolute;
  left: 0;
  right: 0;
  bottom: ${C.bottom}px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: ${C.rowGap}px;
  padding: 0 12px;
  pointer-events: none;
  font: ${C.keyText.weight} ${C.keyText.size}px / 1 ${C.font};
}

.og-hint {
  padding: ${C.hintPadding.y}px ${C.hintPadding.x}px;
  border-radius: 999px;
  background: ${C.hintFill};
  color: ${C.ink};
  font-size: ${C.hintText.size}px;
  font-weight: ${C.hintText.weight};
  line-height: ${C.hintText.lineHeight};
  text-align: center;
}

.og-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: ${C.keyGap}px;
  pointer-events: auto;
}

.og-key {
  all: unset;
  box-sizing: border-box;
  padding: ${C.keyPadding.y}px ${C.keyPadding.x}px;
  border: ${C.keyBorder}px solid ${C.ink};
  border-radius: ${C.keyRadius}px;
  background: ${C.face};
  color: ${C.ink};
  box-shadow: 0 ${C.keyShadow.rest}px 0 ${C.ink};
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: transform 0.12s, box-shadow 0.12s, background 0.3s, color 0.3s;
}

.og-key:hover {
  transform: translateY(${C.keyLift.hover}px);
  box-shadow: 0 ${C.keyShadow.hover}px 0 ${C.ink};
}

.og-key:active {
  transform: translateY(${C.keyLift.pressed}px);
  box-shadow: 0 ${C.keyShadow.pressed}px 0 ${C.ink};
}

.og-key.on {
  background: ${C.ink};
  color: ${C.face};
}

.og-gap {
  width: ${C.spacer}px;
}
`;

export function addStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.append(style);
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const key = document.createElement("button");
  key.type = "button";
  key.className = "og-key";
  key.textContent = label;
  key.addEventListener("click", onClick);
  return key;
}

export function createControls(
  host: HTMLElement,
  season: Season,
  actions: { onSeason(season: Season): void; onNewTree(): void },
): Controls {
  const root = document.createElement("div");
  root.className = "og-ui";

  const hint = document.createElement("div");
  hint.className = "og-hint";
  hint.textContent = C.hint;

  const row = document.createElement("div");
  row.className = "og-row";

  const keys = new Map<Season, HTMLButtonElement>();
  for (const value of SEASONS) {
    const key = button(C.seasons[value], () => actions.onSeason(value));
    keys.set(value, key);
    row.append(key);
  }

  const gap = document.createElement("span");
  gap.className = "og-gap";
  row.append(
    gap,
    button(C.newTree, () => actions.onNewTree()),
  );

  root.append(hint, row);
  host.append(root);

  const select = (value: Season) => {
    for (const [key, element] of keys)
      element.classList.toggle("on", key === value);
  };
  select(season);

  return { select };
}
