/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 *
 * Regenerates the input files (key overlay on the video page) of existing videos
 * from their demos with the current getInputData.
 *
 *   deno task regen-inputs [--dry-run] [--only=<share_id>,...] [--limit=N]
 *     Only videos that already have an input file are checked, and a file is only
 *     rewritten when the new data differs. Demos of board runs were deleted after
 *     processing, so they are downloaded from the board again; requested renders
 *     and LP Hub runs use the demo on disk. Videos whose demo is gone are skipped.
 *     Videos, demos and the database are never changed.
 *
 * Test with one video first: --only=<share_id>, then check its video page.
 */

import { SourceDemoParser } from '@nekz/sdp';
import { db } from '../db.ts';
import { BoardSource, Video } from '~/shared/models.ts';
import { getInputData } from '../demo.ts';
import { getBoardSourceDomain, getDemoFilePath, getDemoInputsFilePath, Storage } from '../utils.ts';
import { basename } from '@std/path';

// Wait between board downloads so a full run doesn't hammer the board.
const BOARD_DOWNLOAD_DELAY = 250;

const getArg = (name: string) => Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const dryRun = Deno.args.includes('--dry-run');
const only = getArg('only')?.split(',').map((id) => id.trim()).filter((id) => id.length) ?? [];
const limit = getArg('limit') ? parseInt(getArg('limit')!, 10) : null;

if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
  console.log('--limit must be a positive number.');
  Deno.exit(1);
}

type VideoSelect = Pick<
  Video,
  'share_id' | 'board_source' | 'board_source_domain' | 'board_changelog_id'
>;

const videos = await db.query<VideoSelect>(
  `select share_id
        , board_source
        , board_source_domain
        , board_changelog_id
     from videos
    where deleted_at is null
      and processed = 1
      ${only.length ? `and share_id in (${only.map(() => '?').join(',')})` : ''}
    order by created_at`,
  only,
);

const readFile = async (path: string) => {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
};

const isBoardDemo = (video: VideoSelect) => !!video.board_changelog_id && video.board_source !== BoardSource.LPHub;

/** Same source as the "Download Demo" button on the video page. */
const getDemo = async (video: VideoSelect) => {
  if (!isBoardDemo(video)) {
    return await readFile(getDemoFilePath(video));
  }

  await new Promise((resolve) => setTimeout(resolve, BOARD_DOWNLOAD_DELAY));

  const domain = getBoardSourceDomain(video.board_source_domain);
  const res = await fetch(`https://${domain}/getDemo?id=${video.board_changelog_id}`, {
    headers: { 'User-Agent': Deno.env.get('USER_AGENT')! },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`board returned ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
};

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);

const parser = SourceDemoParser.default();
const counts = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };

// Only videos with an input file; the rest never had usable input data.
const inputFiles = new Set<string>();
for await (const entry of Deno.readDir(Storage.Inputs)) {
  if (entry.isFile) inputFiles.add(entry.name);
}

const candidates = [];
for (const video of videos) {
  if (!inputFiles.has(basename(getDemoInputsFilePath(video)))) continue;
  const current = await readFile(getDemoInputsFilePath(video));
  if (current) candidates.push({ video, current });
  if (limit !== null && candidates.length === limit) break;
}

console.log(`Checking ${candidates.length} videos with input files${dryRun ? ' (dry run)' : ''}`);

for (const [index, { video, current }] of candidates.entries()) {
  const progress = `[${index + 1}/${candidates.length}] ${video.share_id}`;
  try {
    const demo = await getDemo(video);
    if (!demo) {
      counts.skipped += 1;
      console.log(`${progress} : demo not found, skipped`);
      continue;
    }

    const inputs = getInputData(parser.parse(demo.buffer));
    if (!inputs) {
      counts.skipped += 1;
      console.log(`${progress} : demo has no input data, skipped`);
      continue;
    }

    const regenerated = new Uint8Array(inputs.buffer);
    if (sameBytes(current, regenerated)) {
      counts.unchanged += 1;
      continue;
    }

    if (!dryRun) {
      // Write next to the old file and swap, so the page never reads a partial file.
      const path = getDemoInputsFilePath(video);
      await Deno.writeFile(`${path}.tmp`, regenerated);
      await Deno.rename(`${path}.tmp`, path);
    }

    counts.updated += 1;
    console.log(`${progress} : ${dryRun ? 'would update' : 'updated'}`);
  } catch (err) {
    counts.failed += 1;
    console.log(`${progress} : failed, kept old file : ${err}`);
  }
}

console.log(
  `Done. ${dryRun ? 'Would update' : 'Updated'} ${counts.updated}, unchanged ${counts.unchanged}, ` +
    `skipped ${counts.skipped}, failed ${counts.failed}.`,
);

Deno.exit(counts.failed ? 1 : 0);
