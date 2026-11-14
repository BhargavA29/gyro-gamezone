import type { GameId, GamePlugin } from "@gyro/shared";

const IMPLEMENTED_GAMES = new Set<GameId>(["aim-demo", "target-shooting", "fruit-slicer", "archery"]);

export function isGameImplemented(gameId: GameId): boolean {
  return IMPLEMENTED_GAMES.has(gameId);
}

/**
 * Dynamically imports each game bundle on demand so the host shell and
 * sibling games remain strictly code-split per game.
 */
export async function loadGamePlugin(gameId: GameId): Promise<GamePlugin> {
  switch (gameId) {
    case "target-shooting": {
      const mod = await import("./target-shooting/TargetShootingGame.js");
      return new mod.TargetShootingGame();
    }
    case "fruit-slicer": {
      const mod = await import("./fruit-slicer/FruitSlicerGame.js");
      return new mod.FruitSlicerGame();
    }
    case "archery": {
      const mod = await import("./archery/ArcheryGame.js");
      return new mod.ArcheryGame();
    }
    case "aim-demo":
    default: {
      const mod = await import("./aim-demo/AimDemoGame.js");
      return new mod.AimDemoGame();
    }
  }
}
