/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 */

import { assert, assertEquals } from '@std/assert';
import { SourceDemoParser } from '@nekz/sdp';
import { getInputData, getPlayerInfo } from '../demo.ts';

Deno.test('Correctly get player info of a coop demo', () => {
  const demo = SourceDemoParser.default()
    .setOptions({ stringTables: true })
    .parse(Deno.readFileSync('./tests/demos/coop.dem').buffer);

  const { steamId, partnerSteamId } = getPlayerInfo(demo);

  assert(steamId);
  assert(partnerSteamId);

  assertEquals(BigInt(steamId!), 76561198039230536n);
  assertEquals(BigInt(partnerSteamId!), 76561198045034733n);
});

Deno.test('Correctly get player info of a coop demo (host)', () => {
  const demo = SourceDemoParser.default()
    .setOptions({ stringTables: true })
    .parse(Deno.readFileSync('./tests/demos/coop_host.dem').buffer);

  const { steamId, partnerSteamId } = getPlayerInfo(demo);

  assert(steamId);
  assert(partnerSteamId);

  assertEquals(BigInt(steamId!), 76561198917972968n);
  assertEquals(BigInt(partnerSteamId!), 76561198823602829n);
});

Deno.test('Input data has at most one entry per tick', () => {
  for (const name of ['coop.dem', 'coop_host.dem']) {
    const demo = SourceDemoParser.default().parse(Deno.readFileSync(`./tests/demos/${name}`).buffer);

    const inputs = getInputData(demo);
    assert(inputs);

    // Skip the version and the trailing last tick.
    const ticks = Array.from(inputs.slice(1, -1), (input) => input & 0xf_ffff);
    assert(ticks.length);
    assert(ticks.every((tick, index) => index === 0 || tick > ticks[index - 1]!), `${name} repeats a tick`);
  }
});
