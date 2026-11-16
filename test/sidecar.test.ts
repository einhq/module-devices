import { assertEquals } from '@std/assert';
import { SIDECAR_RANGE, sidecarProblem } from '@devices/sidecar';
import { VERSION } from '../sidecar/discovery.ts';
import manifest from '../mod.json' with { type: 'json' };

Deno.test('a sidecar in the range passes; one older, newer or without a version is named', () => {
  assertEquals(sidecarProblem('0.1.0'), undefined);
  assertEquals(sidecarProblem('0.1.7'), undefined);
  assertEquals(sidecarProblem(undefined)?.endsWith('update the sidecar'), true);
  assertEquals(sidecarProblem('0.0.9'), `the devices sidecar is 0.0.9, older than the ${SIDECAR_RANGE} this module needs: update the sidecar`);
  assertEquals(sidecarProblem('0.2.0'), `the devices sidecar is 0.2.0, newer than the ${SIDECAR_RANGE} this module knows: update the devices module`);
});

Deno.test("the range is the one mod.json gives the installation, and this tree's sidecar meets it", () => {
  assertEquals(manifest.services.devices, SIDECAR_RANGE);
  assertEquals(sidecarProblem(VERSION), undefined);
});
