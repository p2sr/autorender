/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 *
 * Migrates already rendered videos to S3 object storage.
 *
 *   deno task migrate [--dry-run] [--only=<share_id>,...] [--limit=N] [--remote]
 *     Uploads processed videos from the local videos folder to the bucket, checks the
 *     public copy against the local file (size + first/last 64 KiB) and only then points
 *     video_url at the bucket. Local files are never deleted in this step.
 *     --remote also mirrors videos hosted on an external CDN into the bucket; the
 *     processing task regenerates their thumbnails/previews.
 *
 *   deno task migrate --cleanup [--dry-run] [--only=<share_id>,...] [--limit=N]
 *     Deletes local copies of videos that already point at the bucket, after checking
 *     the bucket copy against the local file again. Mismatches are kept and reported.
 *
 * Test with one video first: --only=<share_id>, then check that it plays, then
 * --cleanup --only=<share_id>.
 */

import { db } from '../db.ts';
import { Video } from '~/shared/models.ts';
import { S3Client } from '../s3.ts';
import { getVideoDownloadFilename, getVideoFilePath } from '../utils.ts';

const S3_ENABLED = Deno.env.get('S3_ENABLED')?.toLowerCase() === 'true';

if (!S3_ENABLED) {
  console.log('S3 is not enabled. Set S3_ENABLED=true and the other S3_* variables first.');
  Deno.exit(1);
}

const getArg = (name: string) => Deno.args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const dryRun = Deno.args.includes('--dry-run');
const cleanup = Deno.args.includes('--cleanup');
const includeRemote = Deno.args.includes('--remote');
const only = getArg('only')?.split(',').map((id) => id.trim()).filter((id) => id.length) ?? [];
const limit = getArg('limit') ? parseInt(getArg('limit')!, 10) : null;

if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
  console.log('--limit must be a positive number.');
  Deno.exit(1);
}

if (cleanup && includeRemote) {
  console.log('--cleanup and --remote cannot be combined.');
  Deno.exit(1);
}

const s3 = new S3Client({
  userAgent: Deno.env.get('USER_AGENT')!,
  endpoint: Deno.env.get('S3_ENDPOINT')!,
  region: Deno.env.get('S3_REGION')!,
  bucket: Deno.env.get('S3_BUCKET')!,
  accessKey: Deno.env.get('S3_ACCESS_KEY')!,
  secretKey: Deno.env.get('S3_SECRET_KEY')!,
});

// Everything under this prefix lives in the bucket.
const bucketBaseUrl = s3.getObjectUrl('');

type VideoSelect = Pick<Video, 'video_id' | 'share_id' | 'title' | 'file_name' | 'video_url'>;

const selectVideos = (where: string, params: unknown[]) =>
  db.query<VideoSelect>(
    `select BIN_TO_UUID(video_id) as video_id
          , share_id
          , title
          , file_name
          , video_url
       from videos
      where deleted_at is null
        and ${where}
        ${only.length ? `and share_id in (${only.map(() => '?').join(',')})` : ''}
      order by created_at
      ${limit !== null ? `limit ${limit}` : ''}`,
    [...params, ...only],
  );

const readLocalFile = async (path: string) => {
  try {
    return await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
};

const uploadAndVerify = async (video: VideoSelect, contents: Uint8Array<ArrayBuffer>) => {
  const key = `${video.share_id}.mp4`;
  await s3.putObject({
    key,
    contents,
    contentType: 'video/mp4',
    // NOTE: 'inline' so that the video plays in the browser.
    contentDisposition: `inline; filename="${encodeURIComponent(getVideoDownloadFilename(video))}"`,
  });
  return { key, url: s3.getObjectUrl(key), problem: await s3.verifyObject(key, contents) };
};

const counts = { done: 0, skipped: 0, failed: 0, bytes: 0 };

const run = async (
  videos: VideoSelect[],
  handle: (video: VideoSelect, progress: string) => Promise<'done' | 'skipped' | 'failed'>,
) => {
  for (const [index, video] of videos.entries()) {
    const progress = `[${index + 1}/${videos.length}] ${video.share_id}`;
    try {
      counts[await handle(video, progress)] += 1;
    } catch (err) {
      counts.failed += 1;
      console.log(`${progress} : failed : ${err}`);
    }
  }
};

if (cleanup) {
  const videos = await selectVideos(`video_url like concat(?, '%')`, [bucketBaseUrl]);
  console.log(`Checking ${videos.length} videos in the bucket for local copies${dryRun ? ' (dry run)' : ''}`);

  await run(videos, async (video, progress) => {
    const filePath = getVideoFilePath(video);
    const contents = await readLocalFile(filePath);
    if (!contents) return 'skipped'; // no local copy left

    const problem = await s3.verifyObject(`${video.share_id}.mp4`, contents);
    if (problem) {
      // Keep the local file this run; repair the bucket copy from it so the site plays the right video.
      if (dryRun) {
        console.log(`${progress} : bucket copy does not match (${problem}), would re-upload it from the local file`);
        return 'failed';
      }
      const repair = await uploadAndVerify(video, contents);
      console.log(
        `${progress} : kept local file, bucket copy did not match (${problem}); ` +
          (repair.problem
            ? `re-upload failed too: ${repair.problem}`
            : 're-uploaded it from the local file, run --cleanup again to delete the local copy'),
      );
      return 'failed';
    }

    if (dryRun) {
      console.log(`${progress} : bucket copy verified, would delete ${filePath}`);
    } else {
      await Deno.remove(filePath);
      console.log(`${progress} : bucket copy verified, deleted ${filePath}`);
    }
    counts.bytes += contents.byteLength;
    return 'done';
  });

  console.log(
    `Done. ${dryRun ? 'Would delete' : 'Deleted'} ${counts.done} local files (${Math.round(counts.bytes / 1e6)} MB),` +
      ` ${counts.skipped} had no local file, ${counts.failed} kept because of a problem.`,
  );
  Deno.exit(counts.failed ? 1 : 0);
}

const localVideos = await selectVideos(`video_url like '%/storage/videos/%' and processed = 1`, []);
const remoteVideos = includeRemote
  ? await selectVideos(
    `video_url is not null
       and video_url not like '%/storage/videos/%'
       and video_url not like concat(?, '%')`,
    [bucketBaseUrl],
  )
  : [];

console.log(
  `Found ${localVideos.length} local and ${remoteVideos.length} remote videos to migrate${dryRun ? ' (dry run)' : ''}`,
);

await run(localVideos, async (video, progress) => {
  const filePath = getVideoFilePath(video);
  const contents = await readLocalFile(filePath);
  if (!contents) {
    console.log(`${progress} : missing local file, skipped`);
    return 'skipped';
  }

  if (dryRun) {
    console.log(`${progress} : would upload ${contents.byteLength} bytes`);
    return 'done';
  }

  const { key, url, problem } = await uploadAndVerify(video, contents);
  if (problem) {
    console.log(`${progress} : uploaded but not verified, video left unchanged: ${problem}`);
    return 'failed';
  }

  await db.execute(
    `update videos
        set video_url = ?
          , video_external_id = ?
      where video_id = UUID_TO_BIN(?)`,
    [url, key, video.video_id],
  );

  counts.bytes += contents.byteLength;
  console.log(`${progress} : verified, now ${url} (local file kept)`);
  return 'done';
});

await run(remoteVideos, async (video, progress) => {
  if (dryRun) {
    console.log(`${progress} : would mirror ${video.video_url}`);
    return 'done';
  }

  const res = await fetch(video.video_url, { headers: { 'User-Agent': Deno.env.get('USER_AGENT')! } });
  if (!res.ok) {
    await res.body?.cancel();
    console.log(`${progress} : download returned ${res.status}, skipped`);
    return 'skipped';
  }
  const contents = new Uint8Array(await res.arrayBuffer());

  const { key, url, problem } = await uploadAndVerify(video, contents);
  if (problem) {
    console.log(`${progress} : uploaded but not verified, video left unchanged: ${problem}`);
    return 'failed';
  }

  // The processing task regenerates thumbnails/previews from this local copy and then
  // deletes it, since video_external_id is set.
  await Deno.writeFile(getVideoFilePath(video), contents);
  await db.execute(
    `update videos
        set video_url = ?
          , video_external_id = ?
          , video_size = ?
          , video_preview_url = null
          , thumbnail_url_large = null
          , thumbnail_url_small = null
          , processed = 0
      where video_id = UUID_TO_BIN(?)`,
    [url, key, contents.byteLength, video.video_id],
  );

  counts.bytes += contents.byteLength;
  console.log(`${progress} : verified, now ${url}`);
  return 'done';
});

console.log(
  `Done. ${dryRun ? 'Would migrate' : 'Migrated'} ${counts.done}, skipped ${counts.skipped}, failed ${counts.failed}` +
    (dryRun ? '' : ` (${Math.round(counts.bytes / 1e6)} MB uploaded). Local files were kept; ` +
      'check the videos, then delete local copies with --cleanup.'),
);

Deno.exit(counts.failed ? 1 : 0);
