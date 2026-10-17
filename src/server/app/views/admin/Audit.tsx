/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 */

import * as React from 'react';
import { tw } from 'twind';
import { DataLoader, json, PageMeta, unauthorized, useLoaderData } from '../../Routes.ts';
import { AuditLog, AuditSource, AuditType, UserPermissions } from '~/shared/models.ts';

const PAGE_SIZE = 100;

type AuditRow = AuditLog & {
  source_username: string | null;
  target_username: string | null;
};

type Data = {
  logs: AuditRow[];
  page: number;
  hasMore: boolean;
  source: AuditSource | null;
  type: AuditType | null;
};

export const meta: PageMeta<Data> = () => {
  return {
    title: 'Audit log',
  };
};

const sources = [
  { value: AuditSource.Server, name: 'Server' },
  { value: AuditSource.Client, name: 'Client' },
  { value: AuditSource.Bot, name: 'Bot' },
  { value: AuditSource.User, name: 'User' },
];

const types = [
  { value: AuditType.Info, name: 'Info' },
  { value: AuditType.Warning, name: 'Warning' },
  { value: AuditType.Error, name: 'Error' },
];

const getOption = (value: string | null, options: { value: number }[]) => {
  const number = Number(value);
  return value !== null && value !== '' && options.some((option) => option.value === number) ? number : null;
};

export const loader: DataLoader = async ({ context }) => {
  if (!context.user?.user_id) {
    unauthorized();
  }

  if (!(context.user.permissions & UserPermissions.ViewAuditLogs)) {
    unauthorized();
  }

  const page = Math.max(1, Math.floor(Number(context.url.searchParams.get('page')) || 1));
  const source = getOption(context.url.searchParams.get('source'), sources);
  const type = getOption(context.url.searchParams.get('type'), types);

  const filters = [
    ...(source !== null ? ['audit_logs.source = ?'] : []),
    ...(type !== null ? ['audit_logs.audit_type = ?'] : []),
  ];

  const logs = await context.db.query<AuditRow>(
    `select audit_logs.*
          , source_user.username as source_username
          , target_user.username as target_username
       from audit_logs
  left join users source_user
         on source_user.user_id = audit_logs.source_user_id
  left join users target_user
         on target_user.user_id = audit_logs.target_user_id
      ${filters.length ? `where ${filters.join(' and ')}` : ''}
   order by audit_logs.created_at desc
      limit ?
     offset ?`,
    [
      ...(source !== null ? [source] : []),
      ...(type !== null ? [type] : []),
      PAGE_SIZE + 1,
      (page - 1) * PAGE_SIZE,
    ],
  );

  return json<Data>({
    logs: (logs ?? []).slice(0, PAGE_SIZE),
    page,
    hasMore: (logs ?? []).length > PAGE_SIZE,
    source,
    type,
  });
};

const typeClassName = (type: AuditType) =>
  type === AuditType.Error
    ? tw`text-red-600 dark:text-red-400 font-medium`
    : type === AuditType.Warning
    ? tw`text-yellow-700 dark:text-yellow-400 font-medium`
    : '';

export const Audit = () => {
  const data = useLoaderData<Data>();

  const link = (changes: { page?: number; source?: number | null; type?: number | null }) => {
    const params = new URLSearchParams();
    const source = changes.source !== undefined ? changes.source : data.source;
    const type = changes.type !== undefined ? changes.type : data.type;
    const page = changes.page ?? 1;
    source !== null && params.set('source', source.toString());
    type !== null && params.set('type', type.toString());
    page > 1 && params.set('page', page.toString());
    const query = params.toString();
    return `/admin/audit${query ? `?${query}` : ''}`;
  };

  const filterClassName = (active: boolean) =>
    tw`font-medium rounded-lg text-sm px-3 py-1.5 me-2 mb-2 ${
      active
        ? 'text-white bg-blue-700 dark:bg-blue-600'
        : 'text-gray-900 dark:text-white hover:bg-gray-200 dark:hover:bg-gray-800'
    }`;

  return (
    <div className={tw`lg:flex lg:justify-center`}>
      <div className={tw`lg:w-[75%]`}>
        <div className={tw`text-[20px] mb-4`}>Audit log</div>
        <div className={tw`mb-1`}>
          <span className={tw`text-sm me-2`}>Source:</span>
          <a href={link({ source: null })} className={filterClassName(data.source === null)}>All</a>
          {sources.map(({ value, name }) => (
            <a href={link({ source: value })} className={filterClassName(data.source === value)}>{name}</a>
          ))}
        </div>
        <div className={tw`mb-3`}>
          <span className={tw`text-sm me-2`}>Type:</span>
          <a href={link({ type: null })} className={filterClassName(data.type === null)}>All</a>
          {types.map(({ value, name }) => (
            <a href={link({ type: value })} className={filterClassName(data.type === value)}>{name}</a>
          ))}
        </div>
        <div className={tw`relative overflow-x-auto mb-4`}>
          <table className={tw`w-full text-sm text-left text-black dark:text-white`}>
            <thead className={tw`text-xs uppercase text-white bg-blue-700 dark:text-white`}>
              <tr>
                <th scope='col' className={tw`px-4 py-3`}>Time</th>
                <th scope='col' className={tw`px-4 py-3`}>Type</th>
                <th scope='col' className={tw`px-4 py-3`}>Source</th>
                <th scope='col' className={tw`px-4 py-3`}>By</th>
                <th scope='col' className={tw`px-4 py-3`}>Event</th>
                <th scope='col' className={tw`px-4 py-3`}>Target</th>
                <th scope='col' className={tw`px-4 py-3`}>Details</th>
              </tr>
            </thead>
            <tbody>
              {data.logs.length === 0 && (
                <tr className={tw`bg-blue-50 dark:bg-gray-800`}>
                  <td colSpan={7} className={tw`px-4 py-4 text-center`}>No entries.</td>
                </tr>
              )}
              {data.logs.map((log) => (
                <tr className={tw`bg-blue-50 border-gray-100 dark:bg-gray-800 dark:border-gray-800 align-top`}>
                  <td className={tw`px-4 py-3 whitespace-nowrap`}>{new Date(log.created_at).toLocaleString()}</td>
                  <td className={tw`px-4 py-3 ${typeClassName(log.audit_type)}`}>
                    {types.find(({ value }) =>
                      value === log.audit_type
                    )?.name ?? 'Unknown'}
                  </td>
                  <td className={tw`px-4 py-3`}>
                    {sources.find(({ value }) => value === log.source)?.name ?? '-'}
                  </td>
                  <td className={tw`px-4 py-3`}>{log.source_username ?? '-'}</td>
                  <td className={tw`px-4 py-3`}>{log.title}</td>
                  <td className={tw`px-4 py-3`}>{log.target_username ?? '-'}</td>
                  <td className={tw`px-4 py-3 break-all text-xs text-gray-600 dark:text-gray-400`}>
                    {log.extra ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={tw`flex gap-4`}>
          {data.page > 1 && (
            <a
              href={link({ page: data.page - 1 })}
              className={tw`font-medium text-blue-600 dark:text-blue-400 hover:underline`}
            >
              Newer
            </a>
          )}
          {data.hasMore && (
            <a
              href={link({ page: data.page + 1 })}
              className={tw`font-medium text-blue-600 dark:text-blue-400 hover:underline`}
            >
              Older
            </a>
          )}
        </div>
      </div>
    </div>
  );
};
