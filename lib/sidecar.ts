/**
 * The devices sidecar's versions this module speaks: its environment, the network listener's
 * topics, the broker's accounts and the restreamer's, as `services.devices` in mod.json names
 * them, which is the image line an installation pulls.
 */

import { parse, parseRange, satisfies } from '@std/semver';

export const SIDECAR_RANGE = '^0.1.0';

/**
 * Why a sidecar reporting `version` is not one this module speaks, or undefined when it is. A
 * listener that reports none predates versions: older than any range.
 */
export const sidecarProblem = (version: string | undefined): string | undefined => {
  if (version === undefined) return `the devices sidecar reports no version, older than the ${SIDECAR_RANGE} this module needs: update the sidecar`;
  let parsed;
  try {
    parsed = parse(version);
  } catch {
    return `the devices sidecar reports version ${JSON.stringify(version)}, not a version; this module speaks ${SIDECAR_RANGE}`;
  }
  if (satisfies(parsed, parseRange(SIDECAR_RANGE))) return undefined;
  return satisfies(parsed, parseRange(`<${SIDECAR_RANGE.slice(1)}`))
    ? `the devices sidecar is ${version}, older than the ${SIDECAR_RANGE} this module needs: update the sidecar`
    : `the devices sidecar is ${version}, newer than the ${SIDECAR_RANGE} this module knows: update the devices module`;
};
