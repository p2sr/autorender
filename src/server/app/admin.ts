/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 */

import type { Database } from '../db.ts';
import { AuditSource, AuditType } from '~/shared/models.ts';

const RENDERING_PAUSED = 'rendering_paused';

/** Whether an admin paused rendering, in which case nodes do not get any work. */
export const isRenderingPaused = async (db: Database) => {
  const [setting] = await db.query<{ value: string }>(
    `select value
       from settings
      where name = ?`,
    [RENDERING_PAUSED],
  );

  return setting?.value === 'true';
};

export const setRenderingPaused = async (db: Database, paused: boolean) => {
  await db.execute(
    `insert into settings (name, value)
     values (?, ?)
     on duplicate key update value = values(value)`,
    [RENDERING_PAUSED, paused ? 'true' : 'false'],
  );
};

/** Records an action done by an admin on the site. */
export const logAdminAction = async (
  db: Database,
  userId: number,
  title: string,
  options?: { extra?: string; targetUserId?: number },
) => {
  await db.execute(
    `insert into audit_logs (
            title
          , audit_type
          , source
          , source_user_id
          , target_user_id
          , extra
        ) values (?, ?, ?, ?, ?, ?)`,
    [
      title.slice(0, 512),
      AuditType.Info,
      AuditSource.User,
      userId,
      options?.targetUserId ?? null,
      options?.extra?.slice(0, 1024) ?? null,
    ],
  );
};
