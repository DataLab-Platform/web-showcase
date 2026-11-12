import type { ShowcaseScenario } from "../engine";
import { w1Imaging } from "./w1_imaging";
import { w2Python } from "./w2_python";
import { w3Capsule } from "./w3_capsule";
import { w4AiAssistant } from "./w4_ai_assistant";

/** Native demos, in playing order (application demos are interleaved by
 *  the playlist, see ``../playlist.ts``). */
export const NATIVE_SCENARIOS: ShowcaseScenario[] = [
  w1Imaging,
  w2Python,
  w3Capsule,
  w4AiAssistant,
];
