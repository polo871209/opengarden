import { writeSync } from "node:fs";

export interface TerminalSize {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
}

/** Screen pixels per CSS pixel. Cells at least 24 px tall are HiDPI. */
export const screenScale = (size: TerminalSize) =>
  size.cellHeight >= 24 ? 2 : 1;

export type MouseAction = "press" | "release" | "move";

export interface TerminalHandlers {
  size(size: TerminalSize): void;
  mouse(action: MouseAction, button: number, x: number, y: number): void;
  key(key: string): void;
  graphics(reply: string): void;
}

const MODE = {
  alternateScreen: 1049,
  everyMouseMotion: 1003,
  sgrMouse: 1006,
  sgrMousePixels: 1016,
  inBandResize: 2048,
};
const MODES = Object.values(MODE);

const ESC = "\x1b";
const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const CSI = /^\x1b\[([\x30-\x3f]*)[\x20-\x2f]*([\x40-\x7e])/;
const STRING = /^\x1b([_\]P])([\s\S]*?)(?:\x07|\x1b\\)/;
const PARTIAL = /^\x1b(\[[\x20-\x3f]*|[_\]P][\s\S]*)?$/;

export function write(data: string): void {
  const bytes = Buffer.from(data, "latin1");
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
  }
}

export function openTerminal(handlers: TerminalHandlers): () => void {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error("opengarden needs an interactive terminal");

  let pending = "";
  let loneEscape: NodeJS.Timeout | undefined;
  let cell = { width: 0, height: 0 };

  const report = (columns: number, rows: number) => {
    if (columns > 0 && rows > 0 && cell.width > 0 && cell.height > 0)
      handlers.size({
        columns,
        rows,
        cellWidth: cell.width,
        cellHeight: cell.height,
      });
  };

  const onCsi = (params: string, final: string) => {
    const values = params.split(";").map(Number);
    if (final === "t" && values[0] === 48) {
      const [, rows, columns, height, width] = values;
      cell = {
        width: Math.floor(width / columns),
        height: Math.floor(height / rows),
      };
      report(columns, rows);
    } else if (final === "t" && values[0] === 6) {
      cell = { width: values[2], height: values[1] };
      report(stdout.columns, stdout.rows);
    }
  };

  const consume = (): boolean => {
    if (pending[0] !== ESC) {
      const key = String.fromCodePoint(pending.codePointAt(0) ?? 0);
      pending = pending.slice(key.length);
      handlers.key(key);
      return true;
    }
    const mouse = MOUSE.exec(pending);
    if (mouse) {
      pending = pending.slice(mouse[0].length);
      const code = Number(mouse[1]);
      const action: MouseAction =
        mouse[4] === "m" ? "release" : code & 32 ? "move" : "press";
      if (!(code & 64))
        handlers.mouse(
          action,
          code & 3,
          Number(mouse[2]) - 1,
          Number(mouse[3]) - 1,
        );
      return true;
    }
    const csi = CSI.exec(pending);
    if (csi) {
      pending = pending.slice(csi[0].length);
      onCsi(csi[1], csi[2]);
      return true;
    }
    const string = STRING.exec(pending);
    if (string) {
      pending = pending.slice(string[0].length);
      if (string[1] === "_" && string[2].startsWith("G"))
        handlers.graphics(string[2].slice(1));
      return true;
    }
    if (PARTIAL.test(pending)) return false;
    pending = pending.slice(2);
    return true;
  };

  const onData = (chunk: Buffer) => {
    clearTimeout(loneEscape);
    pending += chunk.toString("latin1");
    while (pending && consume());
    if (pending === ESC)
      loneEscape = setTimeout(() => {
        pending = "";
        handlers.key(ESC);
      }, 50);
  };

  const onResize = () => write(`${ESC}[16t`);

  stdin.setRawMode(true);
  stdin.on("data", onData);
  stdin.resume();
  stdout.on("resize", onResize);
  write(
    `${MODES.map((mode) => `${ESC}[?${mode}h`).join("")}${ESC}[?25l${ESC}[16t`,
  );

  return () => {
    clearTimeout(loneEscape);
    stdin.off("data", onData);
    stdout.off("resize", onResize);
    write(
      `${[...MODES]
        .reverse()
        .map((mode) => `${ESC}[?${mode}l`)
        .join("")}${ESC}]111${ESC}\\${ESC}]22;${ESC}\\${ESC}[?25h`,
    );
    stdin.setRawMode(false);
    stdin.pause();
  };
}
