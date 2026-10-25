import { cherry } from "@opengardenjs/cherry";
import { SEASONS, type Season } from "@opengardenjs/core";
import { mountGarden } from "@opengardenjs/web";

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing`);
  return element;
}

const stage = byId("stage");
const note = byId("stage-note");
const controls = byId("controls");
const seasonRow = byId("seasons");
const newTree = byId("new-tree");

const firstSeason: Season = "autumn";

try {
  const garden = await mountGarden(stage, {
    species: cherry,
    season: firstSeason,
  });

  const seasonKeys = SEASONS.map((season) => {
    const key = document.createElement("button");
    key.type = "button";
    key.className = "key";
    key.textContent = season;
    key.addEventListener("click", () => select(season));
    return key;
  });
  const select = (season: Season) => {
    garden.setSeason(season);
    seasonKeys.forEach((key, index) => {
      key.ariaPressed = String(SEASONS[index] === season);
    });
  };

  seasonRow.append(...seasonKeys);
  newTree.addEventListener("click", () => garden.newTree());
  select(firstSeason);
  controls.hidden = false;
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  note.textContent = `${reason} This is a still image of the garden.`;
  note.hidden = false;
}
