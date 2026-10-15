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
import {
  AccessToken,
  AllRenderSources,
  getRenderPriorities,
  RenderSources,
  User,
  UserPermissions,
} from '~/shared/models.ts';
import { AppStateContext } from '../../AppState.ts';

type NodeJoin =
  & Pick<AccessToken, 'access_token_id' | 'token_name' | 'render_sources' | 'render_priorities' | 'created_at'>
  & Pick<User, 'username'>
  & {
    render_count: number;
  };

type Data = NodeJoin[];

export const meta: PageMeta<Data> = () => {
  return {
    title: 'Nodes',
  };
};

export const loader: DataLoader = async ({ context }) => {
  if (!context.user?.user_id) {
    unauthorized();
  }

  if (!(context.user.permissions & UserPermissions.ManageAccessTokens)) {
    unauthorized();
  }

  const nodes = await context.db.query<NodeJoin>(
    `select access_tokens.access_token_id
          , access_tokens.token_name
          , access_tokens.render_sources
          , access_tokens.render_priorities
          , access_tokens.created_at
          , users.username
          , (
            select count(1)
              from videos
             where videos.rendered_by_token = access_tokens.access_token_id
          ) as render_count
       from access_tokens
       join users
         on users.user_id = access_tokens.user_id
   order by users.username, access_tokens.created_at`,
  );

  return json<Data>(nodes ?? []);
};

export const action: ActionLoader = async ({ params, request, context }) => {
  if (!context.user?.user_id) {
    unauthorized();
  }

  if (!(context.user.permissions & UserPermissions.ManageAccessTokens)) {
    unauthorized();
  }

  const formData = await request.formData();
  const sources = formData.getAll('render_sources').map(Number);

  if (sources.some((source) => !RenderSources.some((renderSource) => renderSource.source === source))) {
    badRequest();
  }

  const renderSources = sources.reduce((mask, source) => mask | (1 << source), 0) & AllRenderSources;

  const priorities = RenderSources.map(({ source }) => Number(formData.get(`priority_${source}`) ?? 1));

  if (priorities.some((priority) => !Number.isInteger(priority) || priority < 1 || priority > RenderSources.length)) {
    badRequest();
  }

  const { affectedRows } = await context.db.execute(
    `update access_tokens set render_sources = ?, render_priorities = ? where access_token_id = ?`,
    [renderSources, priorities.join(','), params.access_token_id],
  );

  if (affectedRows !== 1) {
    badRequest();
  }

  return redirect('/admin/nodes');
};

export const Nodes = () => {
  const state = React.useContext(AppStateContext);
  const nodes = useLoaderData<Data>();

  return (
    <div className={tw`lg:flex lg:justify-center`}>
      <div className={tw`lg:w-[75%]`}>
        <div className={tw`text-[20px] mb-2`}>
          Nodes
        </div>
        <div className={tw`text-sm text-gray-600 dark:text-gray-400 mb-4`}>
          Choose which runs each render node may render. A node with nothing selected stays idle. Priority 1 is rendered
          first; runs with the same priority have no preference.
        </div>
        <div className={tw`relative overflow-x-auto`}>
          <table className={tw`w-full text-sm text-left text-black dark:text-white`}>
            <thead
              className={tw`text-xs uppercase text-white bg-blue-700 dark:text-white`}
            >
              <tr>
                <th scope='col' className={tw`px-6 py-3`}>
                  Node
                </th>
                <th scope='col' className={tw`px-6 py-3`}>
                  Owner
                </th>
                <th scope='col' className={tw`px-6 py-3`}>
                  Status
                </th>
                <th scope='col' className={tw`px-6 py-3`}>
                  Renders
                </th>
                <th scope='col' className={tw`px-6 py-3`}>
                  Runs
                </th>
                <th scope='col' className={tw`px-6 py-3`}>
                </th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => {
                const formId = `node-${node.access_token_id}`;
                const priorities = getRenderPriorities(node.render_priorities);
                return (
                  <tr className={tw`bg-blue-50 border-gray-100 dark:bg-gray-800 dark:border-gray-800`}>
                    <th
                      scope='row'
                      className={tw`px-6 py-4 whitespace-nowrap font-medium text-gray-900 dark:text-white`}
                    >
                      {node.token_name}
                    </th>
                    <td className={tw`px-6 py-4`}>
                      {node.username}
                    </td>
                    <td className={tw`px-6 py-4`}>
                      {state?.clients.includes(node.access_token_id) ? 'Connected' : 'Offline'}
                    </td>
                    <td className={tw`px-6 py-4`}>
                      {node.render_count}
                    </td>
                    <td className={tw`px-6 py-4`}>
                      {RenderSources.map(({ source, name }) => (
                        <div className={tw`flex items-center gap-2 whitespace-nowrap mb-1`}>
                          <input
                            id={`${formId}-source-${source}`}
                            type='checkbox'
                            name='render_sources'
                            value={source}
                            form={formId}
                            defaultChecked={!!(node.render_sources & (1 << source))}
                            className={tw`w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded dark:bg-gray-700 dark:border-gray-600`}
                          />
                          <select
                            name={`priority_${source}`}
                            form={formId}
                            aria-label={`Priority of ${name}`}
                            className={tw`bg-gray-50 border border-gray-300 text-gray-900 text-xs rounded-lg p-1 dark:bg-gray-700 dark:border-gray-600 dark:text-white`}
                          >
                            {RenderSources.map((_, index) => (
                              <option value={index + 1} selected={priorities[source] === index + 1}>
                                {index + 1}
                              </option>
                            ))}
                          </select>
                          <label htmlFor={`${formId}-source-${source}`}>{name}</label>
                        </div>
                      ))}
                    </td>
                    <td className={tw`px-6 py-4 text-right`}>
                      <form id={formId} action={`/admin/nodes/${node.access_token_id}`} method='post'>
                        <button
                          type='submit'
                          className={tw`text-white bg-blue-700 hover:bg-blue-800 focus:ring-4 focus:ring-blue-300 font-medium rounded-lg text-sm px-4 py-2 dark:bg-blue-600 dark:hover:bg-blue-700 focus:outline-none dark:focus:ring-blue-800`}
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
