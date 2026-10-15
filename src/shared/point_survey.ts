/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 */

import { Messages, SourceDemo, SourceDemoBuffer } from '@nekz/sdp';

// Portal 2 removed point_survey (CPointSurvey) in the 2023-03-14 update, so demos
// recorded before it reference a class the game no longer has. See p2sr/demofixup#2.
//
// Demos without point_survey entities get the class replaced with a dummy CPointCamera
// entry like before. Demos with point_survey entities (e.g. Escape, Core) get AR2Explosion
// instead: DT_AR2Explosion has the same flattened network layout as DT_PointSurvey (base
// entity + one string), so the entity data still decodes. This also upgrades demos that
// were already fixed with a CPointCamera entry while containing point_survey entities.
export type PointSurveyFixup = 'fixed' | 'not-needed' | 'unfixable';

/**
 * Fixes the data tables in place. When fixed, save the demo with writeDataTables()
 * and a buffer size of the original size plus extraBytes.
 */
export const fixupPointSurvey = (demo: SourceDemo): { result: PointSurveyFixup; extraBytes: number } => {
  let extraBits = 0;

  const done = (result: PointSurveyFixup) => ({ result, extraBytes: Math.ceil(extraBits / 8) });

  const dt = demo.findMessage(Messages.DataTable)?.dataTable;
  if (!dt) {
    return done('unfixable');
  }

  // Official maps with point_survey entities, in case the string tables cannot be read.
  const mapsWhichUsePointSurvey = [
    'sp_a2_bts2',
    'sp_a2_bts3',
    'sp_a3_portal_intro',
    'sp_a2_core',
    'sp_a2_bts4',
  ];

  const hasEntitiesOfClass = (classId: number) => {
    if (mapsWhichUsePointSurvey.includes(demo.mapName!)) {
      return true;
    }

    try {
      const stringTables = demo.findMessage(Messages.StringTable)?.stringTables;
      const baselines = stringTables?.find((table) => table.name === 'instancebaseline');
      return !!baselines?.entries?.some((entry) => entry.name === classId.toString());
    } catch {
      return false;
    }
  };

  const hasAR2Explosion = dt.tables.some((table) => table.netTableName === 'DT_AR2Explosion');

  const toAR2Explosion = (svc: (typeof dt.serverClasses)[number]) => {
    // writeDataTables() keeps the original buffer size, so make room when the names get longer.
    const growBits = ('AR2Explosion'.length + 'DT_AR2Explosion'.length -
      svc.className!.length - svc.dataTableName!.length) * 8;

    const message = demo.findMessage(Messages.DataTable);
    if (message?.data && growBits > 0) {
      message.data = SourceDemoBuffer.allocateBits(message.data.length + growBits);
      extraBits += growBits;
    }

    svc.className = 'AR2Explosion';
    svc.dataTableName = 'DT_AR2Explosion';
  };

  const pointSurvey = dt.tables.findIndex((table) => table.netTableName === 'DT_PointSurvey');

  // Not fixed yet.
  if (pointSurvey !== -1) {
    const svc = dt.serverClasses.find((table) => table.dataTableName === 'DT_PointSurvey');
    if (!svc) {
      return done('unfixable');
    }

    const usesPointSurvey = hasEntitiesOfClass(svc.classId!);
    if (usesPointSurvey && !hasAR2Explosion) {
      return done('unfixable');
    }

    dt.tables.splice(pointSurvey, 1);

    if (usesPointSurvey) {
      toAR2Explosion(svc);
    } else {
      svc.className = 'CPointCamera';
      svc.dataTableName = 'DT_PointCamera';
    }

    return done('fixed');
  }

  // Fixed before with a dummy CPointCamera entry which is always the second one because
  // classes are sorted by name: CPointCamera < CPointSurvey.
  const pointCameraClasses = dt.serverClasses.filter((table) => table.className === 'CPointCamera');
  if (pointCameraClasses.length === 2) {
    const svc = pointCameraClasses.at(1)!;
    if (!hasEntitiesOfClass(svc.classId!)) {
      return done('not-needed');
    }

    if (!hasAR2Explosion) {
      return done('unfixable');
    }

    toAR2Explosion(svc);
    return done('fixed');
  }

  return done('not-needed');
};
