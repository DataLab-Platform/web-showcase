/**
 * Playlist of the showcase: the native demos with one generated demo per
 * application plugin interleaved — w1, first application, w2, second
 * application, w3, w4…
 */

import { createApplicationScenarios } from "./applications/scenarios";
import {
  NEW_WORKSPACE_ACTION,
  type ShowcaseContext,
  type ShowcaseScenario,
} from "./engine";
import { t } from "./i18n";
import { MIN_DATALAB_WEB_VERSION } from "./options";
import { NATIVE_SCENARIOS } from "./scenarios";

/** ``native[0], extra[0], native[1], extra[1], …`` then the remainder. */
export function interleave<T>(native: readonly T[], extra: readonly T[]): T[] {
  const result: T[] = [];
  for (let i = 0; i < Math.max(native.length, extra.length); i++) {
    if (i < native.length) result.push(native[i]);
    if (i < extra.length) result.push(extra[i]);
  }
  return result;
}

/** Menu actions used by the demos, located once behind the boot card. */
const DEMO_ACTIONS = [NEW_WORKSPACE_ACTION, "file.capsule"];

/** Every available demo, in playing order (DataLab Web must be ready). */
export async function buildPlaylist(
  ctx: ShowcaseContext,
): Promise<ShowcaseScenario[]> {
  if (!(await ctx.hasAutomationHooks())) {
    throw new Error(
      t(
        "This DataLab Web is too old for the showcase: DataLab Web {version} or later is required.",
        { version: MIN_DATALAB_WEB_VERSION },
      ),
    );
  }
  for (const action of DEMO_ACTIONS) await ctx.findActionPath(action);
  return interleave(NATIVE_SCENARIOS, await createApplicationScenarios(ctx));
}

/** Keep the demos whose id is in ``ids`` (all when ``null``), in playlist
 *  order; ``unknown`` lists the ids matching no demo. */
export function selectScenarios<T extends { id: string }>(
  all: readonly T[],
  ids: readonly string[] | null,
): { scenarios: T[]; unknown: string[] } {
  if (!ids) return { scenarios: [...all], unknown: [] };
  const wanted = new Set(ids.map((id) => id.toLowerCase()));
  const known = new Set(all.map((scenario) => scenario.id.toLowerCase()));
  return {
    scenarios: all.filter((scenario) => wanted.has(scenario.id.toLowerCase())),
    unknown: ids.filter((id) => !known.has(id.toLowerCase())),
  };
}
