import { CALL_TRACKER } from './definitions/call-tracker.js'
import { COIN_TRACKER } from './definitions/coin-tracker.js'
import { DIP_HUNTER } from './definitions/dip-hunter.js'
import { LAUNCH_SCANNER } from './definitions/launch-scanner.js'
import { LEVEL_BREAK } from './definitions/level-break.js'
import { MARKET_LOOKUP } from './definitions/market-lookup.js'
import { PRICE_ALERTS } from './definitions/price-alerts.js'
import { PVP_COINS } from './definitions/pvp-coins.js'
import { RUG_WATCH } from './definitions/rug-watch.js'
import { TOKEN_BRIEF } from './definitions/token-brief.js'
import { TRENDING } from './definitions/trending.js'
import { VAMP_WATCH } from './definitions/vamp-watch.js'
import { VOLUME_SPIKES } from './definitions/volume-spikes.js'
import { WHALE_BUYS } from './definitions/whale-buys.js'
import type { FeatureDescriptor } from './types.js'

/**
 * Every feature the bot exposes. Adding one here is all that is required - the
 * dashboard, its API and the settings validator are all generic over this list.
 *
 * RUG_WATCH is deliberately absent: it is parked, not deleted. It answered the
 * same question as Token Brief but replied in the channel, so running both would
 * mean the bot saying the same thing twice, once publicly. Its stored rows are
 * ignored while it is unlisted (`getFeature` returns undefined, so it cannot
 * resolve as enabled). To bring it back, add it to this list and start
 * `RugWatchWorker` again in src/index.ts.
 */
export const FEATURES: FeatureDescriptor[] = [
  MARKET_LOOKUP,
  PRICE_ALERTS,
  COIN_TRACKER,
  LAUNCH_SCANNER,
  TOKEN_BRIEF,
  CALL_TRACKER,
  VOLUME_SPIKES,
  WHALE_BUYS,
  TRENDING,
  DIP_HUNTER,
  LEVEL_BREAK,
  PVP_COINS,
  VAMP_WATCH,
]

/**
 * The volume-monitor features, in the order a status report lists them. They
 * share one worker and one watchlist, so anything that iterates "the monitor"
 * iterates this rather than re-listing the ids.
 */
export const MONITOR_FEATURES: FeatureDescriptor[] = [
  VOLUME_SPIKES,
  WHALE_BUYS,
  TRENDING,
  DIP_HUNTER,
  LEVEL_BREAK,
  PVP_COINS,
  VAMP_WATCH,
]

export const FEATURE_MAP = new Map<string, FeatureDescriptor>(FEATURES.map((f) => [f.id, f]))

export function getFeature(id: string): FeatureDescriptor | undefined {
  return FEATURE_MAP.get(id)
}

/** The feature that owns a slash command, if any gates it. */
export function featureForCommand(commandName: string): FeatureDescriptor | undefined {
  return FEATURES.find((f) => f.commands.includes(commandName))
}

export const FEATURE_IDS = FEATURES.map((f) => f.id)

export {
  CALL_TRACKER,
  COIN_TRACKER,
  DIP_HUNTER,
  LAUNCH_SCANNER,
  LEVEL_BREAK,
  MARKET_LOOKUP,
  PRICE_ALERTS,
  PVP_COINS,
  RUG_WATCH,
  TOKEN_BRIEF,
  TRENDING,
  VAMP_WATCH,
  VOLUME_SPIKES,
  WHALE_BUYS,
}
