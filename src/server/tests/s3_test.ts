/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 */

import { S3Client } from '../s3.ts';
import { getVideoDownloadFilename } from '../utils.ts';

const S3_ENABLED = Deno.env.get('S3_ENABLED')?.toLowerCase() === 'true';

Deno.test('Upload test video to s3', async () => {
  if (!S3_ENABLED) {
    return console.log('Connection to s3 disabled. Skipped test.');
  }

  const s3 = new S3Client({
    userAgent: Deno.env.get('USER_AGENT')!,
    endpoint: Deno.env.get('S3_ENDPOINT')!,
    region: Deno.env.get('S3_REGION')!,
    bucket: Deno.env.get('S3_BUCKET')!,
    accessKey: Deno.env.get('S3_ACCESS_KEY')!,
    secretKey: Deno.env.get('S3_SECRET_KEY')!,
  });

  const key = `${crypto.randomUUID()}.mp4`;
  const contents = await Deno.readFile('./tests/videos/test.mp4');

  const video = {
    title: 'test".dem',
    file_name: 'test".dem',
  };

  const upload = await s3.putObject({
    key,
    contents,
    contentType: 'video/mp4',
    contentDisposition: `inline; filename="${encodeURIComponent(getVideoDownloadFilename(video))}"`,
  });

  const videoUrl = s3.getObjectUrl(key);

  console.log({ upload, videoUrl });

  const res = await fetch(videoUrl);
  console.log('Public download:', res.status);
  await res.body?.cancel();

  await s3.deleteObject(key);
  console.log('Deleted test object');
});
