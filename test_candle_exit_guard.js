import "dotenv/config";
import { runCandleExitGuardFromActivePositions } from "./candle_exit_guard.js";

runCandleExitGuardFromActivePositions({
  onSignal: (sig) => console.log("[SIGNAL]", sig),
}).catch((e) => console.error("guard crashed", e));