/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 */

import type { BoardRenderEntry } from './portal2_sr.ts';

export const LPHUB_BOARD_BASE_API = 'https://lp.portal2.sr';
const LPHUB_API_BASE = `${LPHUB_BOARD_BASE_API}/api/v1`;
const LPHUB_ENABLED = Deno.env.get('LPHUB_ENABLED')?.toLowerCase() === 'true';
const LPHUB_API_TOKEN = Deno.env.get('LPHUB_API_TOKEN')?.trim() ?? '';
const LPHUB_START = Deno.env.get('LPHUB_START')?.trim() ?? '';
const LPHUB_END = Deno.env.get('LPHUB_END')?.trim() ?? '';
const LPHUB_WR_DELTA = Deno.env.get('LPHUB_WR_DELTA')?.trim() || '0';
const LPHUB_LIMIT = Number(Deno.env.get('LPHUB_LIMIT') ?? 100);
const LPHUB_MAX_TICKS = Number(Deno.env.get('LPHUB_MAX_TICKS') ?? 36_000);
const LPHUB_HIDE_OBSOLETE = Deno.env.get('LPHUB_HIDE_OBSOLETE')?.toLowerCase() === 'true';
const LPHUB_MAX_RANK = Number(Deno.env.get('LPHUB_MAX_RANK') ?? 1);

type LPHubScore = {
  user: { steam_id: string; user_name: string };
  map: { name: string; id: number };
  score_time: number;
  score_count: number;
  score_rank: number;
  demo_id: string;
  date: string;
};

type LPHubScoresResponse = {
  success: boolean;
  message: string;
  data: { scores: LPHubScore[] };
};

/** Fetch score logs and adapt them to the fields consumed by the render importer. */
export const getLPHubChangelog = async (): Promise<
  BoardRenderEntry[] | null
> => {
  if (!LPHUB_ENABLED) return null;

  const params = new URLSearchParams({
    wr_delta: LPHUB_WR_DELTA,
    hide_obsolete: LPHUB_HIDE_OBSOLETE.toString(),
    limit: LPHUB_LIMIT.toString(),
    max_ticks: LPHUB_MAX_TICKS.toString(),
    max_rank: LPHUB_MAX_RANK.toString(),
  });

  let start = LPHUB_START;
  const end = LPHUB_END;
  if (!start && !end) {
    // Setting start as yesterday
    start = new Date(Date.now() - 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10);
  }
  if (start) params.set('start', start);
  if (end) params.set('end', end);

  const res = await fetch(`${LPHUB_API_BASE}/stats/scores?${params}`, {
    headers: {
      accept: 'application/json',
      'User-Agent': Deno.env.get('USER_AGENT')!,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`LP Hub score request failed: ${res.status}`);

  const body = (await res.json()) as LPHubScoresResponse;
  if (!body.success || !Array.isArray(body.data?.scores)) {
    throw new Error(`LP Hub score response was unsuccessful: ${body.message}`);
  }

  return body.data.scores.map((score) => {
    return {
      id: score.demo_id,
      player_name: score.user.user_name,
      profile_number: score.user.steam_id,
      post_rank: score.score_rank,
      chamberName: score.map.name,
      mapId: score.map.id,
      // LP Hub reports ticks (60/s), the importer expects centiseconds.
      score: Math.round(score.score_time * 100 / 60),
      portalCount: score.score_count,
      // LP Hub dates are UTC timestamps; retain the supplied UTC calendar date.
      boardRecordDate: score.date.slice(0, 10),
      note: '',
    };
  });
};

/** Fetch a demo by its LP Hub changelog ID. */
export const fetchLPHubDemo = async (
  _id: string | number,
): Promise<{ demo: Response; originalFilename: string }> => {
  if (!LPHUB_API_TOKEN) {
    throw new Error('LPHUB_API_TOKEN is required to download LP Hub demos.');
  }

  const params = new URLSearchParams({ uuid: _id.toString() });
  const demo = await fetch(`${LPHUB_API_BASE}/demos?${params}`, {
    headers: {
      accept: 'application/octet-stream',
      Authorization: LPHUB_API_TOKEN,
      'User-Agent': Deno.env.get('USER_AGENT')!,
    },
    signal: AbortSignal.timeout(10_000),
  });

  // LP Hub reports errors (e.g. a bad token) as JSON with status 200.
  if (demo.headers.get('content-type')?.includes('application/json')) {
    const body = await demo.json().catch(() => null);
    throw new Error(
      `LP Hub demo request failed: ${body?.message ?? demo.status}`,
    );
  }

  return { demo, originalFilename: `${_id}.dem` };
};

/** Notify LP Hub that a demo has been rendered by autorender. */
export const setLPHubAutorender = async (
  autorenderId: string,
  demoId: string,
): Promise<Response> => {
  if (!LPHUB_API_TOKEN) {
    throw new Error('LPHUB_API_TOKEN is required to update LP Hub demos.');
  }

  return await fetch(`${LPHUB_API_BASE}/demos/autorender`, {
    method: 'PUT',
    headers: {
      accept: 'application/json',
      Authorization: LPHUB_API_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent': Deno.env.get('USER_AGENT')!,
    },
    body: JSON.stringify({
      autorender_id: autorenderId,
      demo_id: demoId,
    }),
    signal: AbortSignal.timeout(10_000),
  });
};
