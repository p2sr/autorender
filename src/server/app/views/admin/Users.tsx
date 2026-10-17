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
  notFound,
  PageMeta,
  redirect,
  unauthorized,
  useLoaderData,
} from '../../Routes.ts';
import { User, UserPermissionNames, UserPermissions } from '~/shared/models.ts';
import { logAdminAction } from '../../admin.ts';

type UserRow = Pick<User, 'user_id' | 'username' | 'discord_id' | 'permissions' | 'created_at'>;

type Data = {
  users: UserRow[];
  totalUsers: number;
  showAll: boolean;
  query: string;
  currentUserId: number;
  saved: string | null;
};

export const meta: PageMeta<Data> = () => {
  return {
    title: 'Users',
  };
};

// Permissions every user gets when they first log in.
const DefaultPermissions = UserPermissions.ListVideos;

const AllPermissions = UserPermissionNames.reduce((mask, { permission }) => mask | permission, 0);

const formatPermissions = (permissions: number) =>
  UserPermissionNames.filter(({ permission }) => permissions & permission).map(({ name }) => name).join(', ') ||
  'None';

export const loader: DataLoader = async ({ context }) => {
  if (!context.user?.user_id) {
    unauthorized();
  }

  if (!(context.user.permissions & UserPermissions.ManageUsers)) {
    unauthorized();
  }

  const query = context.url.searchParams.get('q')?.trim() ?? '';
  const showAll = context.url.searchParams.get('all') === '1';

  // By default only list users whose permissions differ from the default, search always covers everyone.
  const users = await context.db.query<UserRow>(
    `select user_id
          , username
          , discord_id
          , permissions
          , created_at
       from users
      ${query ? 'where username like ? or discord_id = ?' : showAll ? '' : 'where permissions <> ?'}
   order by permissions desc, username`,
    query ? [`%${query}%`, query] : showAll ? [] : [DefaultPermissions],
  );

  const [total] = await context.db.query<{ count: number }>(`select count(*) as count from users`);

  return json<Data>({
    users: users ?? [],
    totalUsers: Number(total?.count ?? 0),
    showAll,
    query,
    currentUserId: context.user.user_id,
    saved: context.url.searchParams.get('saved'),
  });
};

export const action: ActionLoader = async ({ params, request, context }) => {
  if (!context.user?.user_id) {
    unauthorized();
  }

  if (!(context.user.permissions & UserPermissions.ManageUsers)) {
    unauthorized();
  }

  const userId = Number(params.user_id);
  if (!Number.isInteger(userId)) {
    badRequest();
  }

  const formData = await request.formData();
  const permissions = formData.getAll('permission').map(Number);

  if (permissions.some((permission) => !UserPermissionNames.some((entry) => entry.permission === permission))) {
    badRequest();
  }

  const newPermissions = permissions.reduce((mask, permission) => mask | permission, 0) & AllPermissions;

  // Do not let admins lock themselves out of this page.
  if (userId === context.user.user_id && !(newPermissions & UserPermissions.ManageUsers)) {
    badRequest();
  }

  const [user] = await context.db.query<Pick<User, 'username' | 'permissions'>>(
    `select username, permissions from users where user_id = ?`,
    [userId],
  );

  if (!user) {
    notFound();
  }

  await context.db.execute(
    `update users set permissions = ? where user_id = ?`,
    [newPermissions, userId],
  );

  await logAdminAction(context.db, context.user.user_id, `Changed permissions of ${user.username}`, {
    targetUserId: userId,
    extra: `${formatPermissions(user.permissions)} -> ${formatPermissions(newPermissions)}`,
  });

  const query = formData.get('q')?.toString() ?? '';
  return redirect(
    `/admin/users?${query ? `q=${encodeURIComponent(query)}&` : ''}${
      formData.get('all') === '1' ? 'all=1&' : ''
    }saved=${encodeURIComponent(user.username)}`,
  );
};

export const Users = () => {
  const data = useLoaderData<Data>();

  return (
    <div className={tw`lg:flex lg:justify-center`}>
      <div className={tw`lg:w-[75%]`}>
        <div className={tw`text-[20px] mb-2`}>Users</div>
        <div className={tw`text-sm text-gray-600 dark:text-gray-400 mb-4`}>
          Changes apply the next time the user logs in. You cannot remove your own "Manage users" permission.
        </div>
        <div className={tw`text-sm mb-4`}>
          {data.query
            ? `${data.users.length} of ${data.totalUsers} users match "${data.query}".`
            : data.showAll
            ? `Showing all ${data.totalUsers} users.`
            : `Showing ${data.users.length} of ${data.totalUsers} users: only those with permissions other than the default (List videos).`}
          {' '}
          {!data.query && (
            <a
              href={data.showAll ? '/admin/users' : '/admin/users?all=1'}
              className={tw`font-medium text-blue-600 dark:text-blue-400 hover:underline`}
            >
              {data.showAll ? 'Show only users with changed permissions' : 'Show all users'}
            </a>
          )}
        </div>
        {data.saved && (
          <div
            className={tw`text-sm mb-4 p-3 rounded-lg bg-green-50 text-green-800 dark:bg-gray-800 dark:text-green-400`}
          >
            Saved permissions of {data.saved}.
          </div>
        )}
        <form action='/admin/users' method='get' className={tw`flex gap-2 mb-4`}>
          <input
            type='text'
            name='q'
            value={data.query}
            placeholder='Username or Discord ID'
            className={tw`bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full max-w-sm p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:text-white`}
          />
          <button
            type='submit'
            className={tw`text-white bg-blue-700 hover:bg-blue-800 font-medium rounded-lg text-sm px-5 py-2.5 dark:bg-blue-600 dark:hover:bg-blue-700`}
          >
            Search
          </button>
        </form>
        <div className={tw`relative overflow-x-auto`}>
          <table className={tw`w-full text-sm text-left text-black dark:text-white`}>
            <thead className={tw`text-xs uppercase text-white bg-blue-700 dark:text-white`}>
              <tr>
                <th scope='col' className={tw`px-4 py-3`}>User</th>
                <th scope='col' className={tw`px-4 py-3`}>Permissions</th>
                <th scope='col' className={tw`px-4 py-3`}></th>
              </tr>
            </thead>
            <tbody>
              {data.users.length === 0 && (
                <tr className={tw`bg-blue-50 dark:bg-gray-800`}>
                  <td colSpan={3} className={tw`px-4 py-4 text-center`}>No users found.</td>
                </tr>
              )}
              {data.users.map((user) => {
                const formId = `user-${user.user_id}`;
                const isSelf = user.user_id === data.currentUserId;
                return (
                  <tr className={tw`bg-blue-50 border-gray-100 dark:bg-gray-800 dark:border-gray-800 align-top`}>
                    <td className={tw`px-4 py-3 whitespace-nowrap`}>
                      <a
                        href={`/profile/${user.username}`}
                        className={tw`font-medium text-blue-600 dark:text-blue-400 hover:underline`}
                      >
                        {user.username}
                      </a>
                      {isSelf && <span className={tw`ms-1 text-xs text-gray-500`}>(you)</span>}
                      <div className={tw`text-xs text-gray-500 dark:text-gray-400`}>{user.discord_id}</div>
                    </td>
                    <td className={tw`px-4 py-3`}>
                      <div className={tw`grid grid-cols-1 md:grid-cols-3 gap-x-4 gap-y-1`}>
                        {UserPermissionNames.map(({ permission, name }) => (
                          <label className={tw`flex items-center gap-2 whitespace-nowrap`}>
                            <input
                              type='checkbox'
                              name='permission'
                              value={permission}
                              form={formId}
                              defaultChecked={!!(user.permissions & permission)}
                              disabled={isSelf && permission === UserPermissions.ManageUsers}
                              className={tw`w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600`}
                            />
                            {name}
                          </label>
                        ))}
                      </div>
                    </td>
                    <td className={tw`px-4 py-3 text-right`}>
                      <form id={formId} action={`/admin/users/${user.user_id}`} method='post'>
                        {data.query && <input type='hidden' name='q' value={data.query} />}
                        {data.showAll && <input type='hidden' name='all' value='1' />}
                        {isSelf && <input type='hidden' name='permission' value={UserPermissions.ManageUsers} />}
                        <button
                          type='submit'
                          className={tw`text-white bg-blue-700 hover:bg-blue-800 font-medium rounded-lg text-sm px-4 py-2 dark:bg-blue-600 dark:hover:bg-blue-700`}
                        >
                          Save
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
