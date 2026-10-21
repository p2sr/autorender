/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 */

import * as React from 'react';
import { tw } from 'twind';
import {
  ActionLoader,
  badRequest,
  DataLoader,
  json,
  PageMeta,
  redirect,
  unauthorized,
  useLoaderData,
} from '../../Routes.ts';
import { BoardSource, DeleteReason, PendingStatus, RenderSources, UserPermissions, Video } from '~/shared/models.ts';
import { isRenderingPaused, logAdminAction, setRenderingPaused } from '../../admin.ts';

const REMOVED_FROM_QUEUE = 'Removed from queue';
const LIST_LIMIT = 50;

type QueueVideo =
  & Pick<
    Video,
    | 'share_id'
    | 'title'
    | 'created_at'
    | 'pending'
    | 'queue_priority'
    | 'board_source'
    | 'render_node'
    | 'requested_by_name'
    | 'deleted_at'
  >
  & {
    requested_by_username: string | null;
  };

type Data = {
  paused: boolean;
  source: BoardSource | null;
  queued: QueueVideo[];
  failed: QueueVideo[];
  removed: QueueVideo[];
  done: string | null;
  count: number | null;
};

export const meta: PageMeta<Data> = () => {
  return {
    title: 'Queue',
  };
};

const getSource = (value: string | null) => {
  const source = Number(value);
  return value !== null && value !== '' && RenderSources.some((renderSource) => renderSource.source === source)
    ? source
    : null;
};

const selectVideos = `select videos.share_id
          , videos.title
          , videos.created_at
          , videos.pending
          , videos.queue_priority
          , videos.board_source
          , videos.render_node
          , videos.requested_by_name
          , videos.deleted_at
          , requester.username as requested_by_username
       from videos
       left join users requester
         on requester.discord_id = videos.requested_by_id`;

export const loader: DataLoader = async ({ context }) => {
  if (!context.user?.user_id) {
    unauthorized();
  }

  if (!(context.user.permissions & UserPermissions.DeleteVideos)) {
    unauthorized();
  }

  const source = getSource(context.url.searchParams.get('source'));
  const sourceFilter = source !== null ? 'and videos.board_source = ?' : '';
  const sourceParams = source !== null ? [source] : [];

  const queued = await context.db.query<QueueVideo>(
    `${selectVideos}
      where videos.pending <> ?
        and videos.video_url is null
        and videos.deleted_at is null
        ${sourceFilter}
   order by videos.queue_priority desc, videos.created_at`,
    [PendingStatus.FinishedRender, ...sourceParams],
  );

  // Never got a video: the render failed, the node gave up or it went stale.
  const failed = await context.db.query<QueueVideo>(
    `${selectVideos}
      where videos.pending = ?
        and videos.video_url is null
        and videos.deleted_at is null
        ${sourceFilter}
   order by videos.created_at desc
      limit ?`,
    [PendingStatus.FinishedRender, ...sourceParams, LIST_LIMIT],
  );

  const removed = await context.db.query<QueueVideo>(
    `${selectVideos}
      where videos.deleted_at is not null
        and videos.deleted_reason = ?
        and videos.video_url is null
        ${sourceFilter}
   order by videos.deleted_at desc
      limit ?`,
    [REMOVED_FROM_QUEUE, ...sourceParams, LIST_LIMIT],
  );

  const count = context.url.searchParams.get('count');

  return json<Data>({
    paused: await isRenderingPaused(context.db),
    source,
    queued: queued ?? [],
    failed: failed ?? [],
    removed: removed ?? [],
    done: context.url.searchParams.get('done'),
    count: count !== null && !isNaN(Number(count)) ? Number(count) : null,
  });
};

export const action: ActionLoader = async ({ request, context }) => {
  if (!context.user?.user_id) {
    unauthorized();
  }

  if (!(context.user.permissions & UserPermissions.DeleteVideos)) {
    unauthorized();
  }

  const formData = await request.formData();
  const intent = formData.get('intent')?.toString();
  const source = getSource(formData.get('source')?.toString() ?? null);
  const shareIds = formData.getAll('share_id').map(String).filter((shareId) => shareId.length);
  const userId = context.user.user_id;

  const back = (done: string, count?: number) =>
    redirect(
      `/admin/queue?${source !== null ? `source=${source}&` : ''}done=${done}${
        count !== undefined ? `&count=${count}` : ''
      }`,
    );

  const inShareIds = () => `and share_id in (${shareIds.map(() => '?').join(',')})`;

  switch (intent) {
    case 'pause':
    case 'resume': {
      const paused = intent === 'pause';
      await setRenderingPaused(context.db, paused);
      await logAdminAction(context.db, userId, paused ? 'Paused rendering' : 'Resumed rendering');
      return back(intent);
    }
    case 'remove-selected':
    case 'remove-all': {
      const removeAll = intent === 'remove-all';

      if (removeAll && formData.get('confirm_all') !== 'on') {
        badRequest();
      }

      if (!removeAll && !shareIds.length) {
        badRequest();
      }

      // Only waiting videos: claimed ones are already being rendered by a node.
      // Removed videos are kept as deleted so that board importers do not queue them again.
      const { affectedRows } = await context.db.execute(
        `update videos
            set pending = ?
              , deleted_at = current_timestamp()
              , deleted_by = ?
              , deleted_reason = ?
              , deleted_reason_type = ?
          where pending = ?
            and video_url is null
            and deleted_at is null
            ${removeAll && source !== null ? 'and board_source = ?' : ''}
            ${removeAll ? '' : inShareIds()}`,
        [
          PendingStatus.FinishedRender,
          userId,
          REMOVED_FROM_QUEUE,
          DeleteReason.Other,
          PendingStatus.RequiresRender,
          ...(removeAll && source !== null ? [source] : []),
          ...(removeAll ? [] : shareIds),
        ],
      );

      await logAdminAction(context.db, userId, `Removed ${affectedRows ?? 0} videos from the queue`, {
        extra: removeAll ? `All waiting${source !== null ? `, board source ${source}` : ''}` : shareIds.join(','),
      });

      return back('removed', affectedRows ?? 0);
    }
    case 'front': {
      if (shareIds.length !== 1) {
        badRequest();
      }

      const [top] = await context.db.query<{ priority: number | null }>(
        `select max(queue_priority) as priority
           from videos
          where pending = ?
            and video_url is null
            and deleted_at is null`,
        [PendingStatus.RequiresRender],
      );

      const { affectedRows } = await context.db.execute(
        `update videos
            set queue_priority = ?
          where pending = ?
            and video_url is null
            and deleted_at is null
            ${inShareIds()}`,
        [(top?.priority ?? 0) + 1, PendingStatus.RequiresRender, ...shareIds],
      );

      await logAdminAction(context.db, userId, 'Moved video to the front of the queue', { extra: shareIds[0] });

      return back('front', affectedRows ?? 0);
    }
    case 'release': {
      if (shareIds.length !== 1) {
        badRequest();
      }

      // For videos stuck on a node that was closed or crashed while rendering. The node cannot upload it anymore
      // since the video is no longer assigned to it. rerender_started_at keeps the stale task from expiring it.
      const { affectedRows } = await context.db.execute(
        `update videos
            set pending = ?
              , rendered_by = null
              , rendered_by_token = null
              , render_node = null
              , rerender_started_at = current_timestamp()
          where pending in (?, ?, ?)
            and deleted_at is null
            ${inShareIds()}`,
        [
          PendingStatus.RequiresRender,
          PendingStatus.ClaimedRender,
          PendingStatus.StartedRender,
          PendingStatus.UploadingRender,
          ...shareIds,
        ],
      );

      await logAdminAction(context.db, userId, 'Released video from its render node', { extra: shareIds[0] });

      return back('released', affectedRows ?? 0);
    }
    case 'retry': {
      if (!shareIds.length) {
        badRequest();
      }

      // rerender_started_at keeps the stale task from expiring them right away.
      const { affectedRows } = await context.db.execute(
        `update videos
            set pending = ?
              , rerender_started_at = current_timestamp()
          where pending = ?
            and video_url is null
            and deleted_at is null
            ${inShareIds()}`,
        [PendingStatus.RequiresRender, PendingStatus.FinishedRender, ...shareIds],
      );

      await logAdminAction(context.db, userId, `Retried ${affectedRows ?? 0} failed renders`, {
        extra: shareIds.join(','),
      });

      return back('retried', affectedRows ?? 0);
    }
    case 'restore': {
      if (!shareIds.length) {
        badRequest();
      }

      const { affectedRows } = await context.db.execute(
        `update videos
            set pending = ?
              , rerender_started_at = current_timestamp()
              , deleted_at = null
              , deleted_by = null
              , deleted_reason = null
              , deleted_reason_type = ?
          where deleted_at is not null
            and deleted_reason = ?
            and video_url is null
            ${inShareIds()}`,
        [PendingStatus.RequiresRender, DeleteReason.Unknown, REMOVED_FROM_QUEUE, ...shareIds],
      );

      await logAdminAction(context.db, userId, `Restored ${affectedRows ?? 0} videos to the queue`, {
        extra: shareIds.join(','),
      });

      return back('restored', affectedRows ?? 0);
    }
    default:
      badRequest();
  }
};

const formatStatus = (status: PendingStatus) => {
  switch (status) {
    case PendingStatus.RequiresRender:
      return 'Waiting';
    case PendingStatus.ClaimedRender:
      return 'Claimed';
    case PendingStatus.StartedRender:
      return 'Rendering';
    case PendingStatus.UploadingRender:
      return 'Uploading';
    default:
      return '-';
  }
};

const getSourceName = (source: BoardSource) => {
  return RenderSources.find((renderSource) => renderSource.source === source)?.name ?? '-';
};

const formatDone = (done: string, count: number | null) => {
  const videos = (n: number | null) => `${n ?? 0} ${n === 1 ? 'video' : 'videos'}`;
  switch (done) {
    case 'pause':
      return 'Rendering is paused. Nodes will not get any new work.';
    case 'resume':
      return 'Rendering resumed.';
    case 'removed':
      return `Removed ${videos(count)} from the queue.`;
    case 'front':
      return count ? 'Moved the video to the front of the queue.' : 'The video is no longer waiting.';
    case 'released':
      return count
        ? 'Released the video. It is back in the queue for the next free node.'
        : 'The video is no longer being rendered.';
    case 'retried':
      return `Put ${videos(count)} back in the queue.`;
    case 'restored':
      return `Restored ${videos(count)} to the queue.`;
    default:
      return null;
  }
};

const checkboxClassName =
  tw`w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600`;
const linkClassName = tw`font-medium text-blue-600 dark:text-blue-400 hover:underline`;
const buttonClassName = (color: 'blue' | 'red' | 'gray') =>
  tw`text-white font-medium rounded-lg text-sm px-5 py-2.5 focus:outline-none focus:ring-4 ${
    color === 'red'
      ? 'bg-red-700 hover:bg-red-800 focus:ring-red-300 dark:bg-red-600 dark:hover:bg-red-700'
      : color === 'gray'
      ? 'bg-gray-500 hover:bg-gray-700 focus:ring-gray-300 dark:bg-gray-600 dark:hover:bg-gray-700'
      : 'bg-blue-700 hover:bg-blue-800 focus:ring-blue-300 dark:bg-blue-600 dark:hover:bg-blue-700'
  }`;

const Table = ({ headers, children, empty }: { headers: string[]; children: React.ReactNode[]; empty: string }) => (
  <div className={tw`relative overflow-x-auto mb-4`}>
    <table className={tw`w-full text-sm text-left text-black dark:text-white`}>
      <thead className={tw`text-xs uppercase text-white bg-blue-700 dark:text-white`}>
        <tr>
          {headers.map((header) => <th scope='col' className={tw`px-4 py-3 whitespace-nowrap`}>{header}</th>)}
        </tr>
      </thead>
      <tbody>
        {children.length ? children : (
          <tr className={tw`bg-blue-50 dark:bg-gray-800`}>
            <td colSpan={headers.length} className={tw`px-4 py-4 text-center`}>{empty}</td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
);

const rowClassName = tw`bg-blue-50 border-gray-100 dark:bg-gray-800 dark:border-gray-800`;
const cellClassName = tw`px-4 py-3`;

export const Queue = () => {
  const data = useLoaderData<Data>();
  const waiting = data.queued.filter((video) => video.pending === PendingStatus.RequiresRender).length;
  const message = data.done ? formatDone(data.done, data.count) : null;

  const filterClassName = (active: boolean) =>
    tw`font-medium rounded-lg text-sm px-4 py-2 me-2 mb-2 ${
      active
        ? 'text-white bg-blue-700 dark:bg-blue-600'
        : 'text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-800'
    }`;

  const sourceInput = data.source !== null && <input type='hidden' name='source' value={data.source} />;

  return (
    <div className={tw`lg:flex lg:justify-center`}>
      <div className={tw`lg:w-[75%]`}>
        <div className={tw`flex flex-wrap items-center justify-between gap-4 mb-2`}>
          <div className={tw`text-[20px]`}>Queue</div>
          <form action='/admin/queue' method='post' className={tw`flex items-center gap-3`}>
            {sourceInput}
            <span className={tw`text-sm ${data.paused ? 'text-red-600 dark:text-red-400 font-medium' : ''}`}>
              {data.paused ? 'Rendering is paused' : 'Rendering is running'}
            </span>
            <button
              type='submit'
              name='intent'
              value={data.paused ? 'resume' : 'pause'}
              className={buttonClassName(data.paused ? 'blue' : 'gray')}
            >
              {data.paused ? 'Resume rendering' : 'Pause rendering'}
            </button>
          </form>
        </div>
        <div className={tw`text-sm text-gray-600 dark:text-gray-400 mb-4`}>
          {waiting} waiting, {data.queued.length - waiting}{' '}
          being rendered. Removed videos are kept as deleted so they are not queued again. Videos that are being
          rendered cannot be removed. Release a video only when its node was closed or crashed: it goes back in the
          queue and its node can no longer upload it.
        </div>
        {message && (
          <div
            className={tw`text-sm mb-4 p-3 rounded-lg bg-green-50 text-green-800 dark:bg-gray-800 dark:text-green-400`}
          >
            {message}
          </div>
        )}
        <div className={tw`mb-2`}>
          <a href='/admin/queue' className={filterClassName(data.source === null)}>All</a>
          {RenderSources.map(({ source, name }) => (
            <a href={`/admin/queue?source=${source}`} className={filterClassName(data.source === source)}>
              {name}
            </a>
          ))}
        </div>

        <form id='queue-front' action='/admin/queue' method='post'>
          {sourceInput}
          <input type='hidden' name='intent' value='front' />
        </form>
        <form id='queue-release' action='/admin/queue' method='post'>
          {sourceInput}
          <input type='hidden' name='intent' value='release' />
        </form>
        <form action='/admin/queue' method='post' className={tw`mb-10`}>
          {sourceInput}
          <Table
            headers={['', 'Title', 'Run type', 'Status', 'Node', 'Requested by', 'Queued at', '']}
            empty='The queue is empty.'
          >
            {data.queued.map((video) => (
              <tr className={rowClassName}>
                <td className={cellClassName}>
                  {video.pending === PendingStatus.RequiresRender && (
                    <input
                      type='checkbox'
                      name='share_id'
                      value={video.share_id}
                      aria-label={`Select ${video.title}`}
                      className={checkboxClassName}
                    />
                  )}
                </td>
                <td className={cellClassName}>
                  <a href={`/queue/${video.share_id}`} className={linkClassName}>{video.title}</a>
                  {video.queue_priority > 0 && video.pending === PendingStatus.RequiresRender && (
                    <span className={tw`ms-2 text-xs font-medium text-blue-700 dark:text-blue-400`}>
                      (moved to front)
                    </span>
                  )}
                </td>
                <td className={tw`px-4 py-3 whitespace-nowrap`}>{getSourceName(video.board_source)}</td>
                <td className={cellClassName}>{formatStatus(video.pending)}</td>
                <td className={cellClassName}>{video.render_node ?? '-'}</td>
                <td className={cellClassName}>{video.requested_by_username ?? video.requested_by_name ?? '-'}</td>
                <td className={tw`px-4 py-3 whitespace-nowrap`}>{new Date(video.created_at).toLocaleString()}</td>
                <td className={tw`px-4 py-3 text-right whitespace-nowrap`}>
                  {video.pending === PendingStatus.RequiresRender && (
                    <button
                      form='queue-front'
                      type='submit'
                      name='share_id'
                      value={video.share_id}
                      className={linkClassName}
                    >
                      Move to front
                    </button>
                  )}
                  {video.pending !== PendingStatus.RequiresRender && (
                    <button
                      form='queue-release'
                      type='submit'
                      name='share_id'
                      value={video.share_id}
                      className={tw`font-medium text-red-600 dark:text-red-400 hover:underline`}
                    >
                      Release
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
          <div className={tw`flex flex-wrap items-center gap-4`}>
            <button type='submit' name='intent' value='remove-selected' className={buttonClassName('red')}>
              Remove selected
            </button>
            <label className={tw`flex items-center gap-2 text-sm`}>
              <input type='checkbox' name='confirm_all' className={checkboxClassName} />
              Confirm removing all {data.source !== null ? getSourceName(data.source) : ''} waiting videos
            </label>
            <button
              type='submit'
              name='intent'
              value='remove-all'
              className={tw`text-red-700 border border-red-700 hover:bg-red-800 hover:text-white focus:ring-4 focus:ring-red-300 font-medium rounded-lg text-sm px-5 py-2.5 dark:border-red-500 dark:text-red-500 dark:hover:text-white dark:hover:bg-red-600 focus:outline-none dark:focus:ring-red-900`}
            >
              Remove all waiting
            </button>
          </div>
        </form>

        <div className={tw`text-[18px] mb-1`}>Failed renders</div>
        <div className={tw`text-sm text-gray-600 dark:text-gray-400 mb-3`}>
          Videos that never got a video file because the render failed or went stale. Latest {LIST_LIMIT}.
        </div>
        <form action='/admin/queue' method='post' className={tw`mb-10`}>
          {sourceInput}
          <Table headers={['', 'Title', 'Run type', 'Node', 'Requested by', 'Queued at']} empty='No failed renders.'>
            {data.failed.map((video) => (
              <tr className={rowClassName}>
                <td className={cellClassName}>
                  <input
                    type='checkbox'
                    name='share_id'
                    value={video.share_id}
                    aria-label={`Select ${video.title}`}
                    className={checkboxClassName}
                  />
                </td>
                <td className={cellClassName}>
                  <a href={`/queue/${video.share_id}`} className={linkClassName}>{video.title}</a>
                </td>
                <td className={tw`px-4 py-3 whitespace-nowrap`}>{getSourceName(video.board_source)}</td>
                <td className={cellClassName}>{video.render_node ?? '-'}</td>
                <td className={cellClassName}>{video.requested_by_username ?? video.requested_by_name ?? '-'}</td>
                <td className={tw`px-4 py-3 whitespace-nowrap`}>{new Date(video.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </Table>
          <button type='submit' name='intent' value='retry' className={buttonClassName('blue')}>
            Retry selected
          </button>
        </form>

        <div className={tw`text-[18px] mb-1`}>Recently removed</div>
        <div className={tw`text-sm text-gray-600 dark:text-gray-400 mb-3`}>
          Videos removed from the queue on this page. Latest {LIST_LIMIT}.
        </div>
        <form action='/admin/queue' method='post'>
          {sourceInput}
          <Table headers={['', 'Title', 'Run type', 'Requested by', 'Removed at']} empty='Nothing was removed.'>
            {data.removed.map((video) => (
              <tr className={rowClassName}>
                <td className={cellClassName}>
                  <input
                    type='checkbox'
                    name='share_id'
                    value={video.share_id}
                    aria-label={`Select ${video.title}`}
                    className={checkboxClassName}
                  />
                </td>
                <td className={cellClassName}>{video.title}</td>
                <td className={tw`px-4 py-3 whitespace-nowrap`}>{getSourceName(video.board_source)}</td>
                <td className={cellClassName}>{video.requested_by_username ?? video.requested_by_name ?? '-'}</td>
                <td className={tw`px-4 py-3 whitespace-nowrap`}>
                  {video.deleted_at ? new Date(video.deleted_at).toLocaleString() : '-'}
                </td>
              </tr>
            ))}
          </Table>
          <button type='submit' name='intent' value='restore' className={buttonClassName('blue')}>
            Restore selected
          </button>
        </form>
      </div>
    </div>
  );
};
