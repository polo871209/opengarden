import { cherry } from "@opengardenjs/cherry";
import { SEASONS } from "@opengardenjs/core";
import { mountGarden } from "@opengardenjs/web";

const stage = document.getElementById("stage");
if (!stage) throw new Error("#stage is missing");

const params = new URLSearchParams(location.search);

try {
  const garden = await mountGarden(stage, {
    species: cherry,
    seed: Number(params.get("seed")) || undefined,
    season: SEASONS.find((season) => season === params.get("season")),
    controls: params.get("controls") === "1",
  });
  if (import.meta.env.DEV) Object.assign(window, { garden });
} catch (error) {
  const message = document.createElement("p");
  message.className = "error";
  message.textContent = error instanceof Error ? error.message : String(error);
  stage.append(message);
  throw error;
}
