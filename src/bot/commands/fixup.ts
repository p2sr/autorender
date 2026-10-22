/*
 * Copyright (c) 2023-2025, NeKz
 *
 * SPDX-License-Identifier: MIT
 */

import { ApplicationCommandOptionTypes, ApplicationCommandTypes, InteractionResponseTypes } from '@discordeno/bot';
import { Messages, SourceDemoParser } from '@nekz/sdp';
import { Server } from '../services/server.ts';
import { fixupPointSurvey } from '~/shared/point_survey.ts';
import { DemoFixupError, fixupDemo } from '~/shared/demofixup.ts';
import { createCommand, DiscordBot, DiscordInteraction } from '../bot.ts';

createCommand({
  name: 'fixup',
  description: 'Fix an old demo file!',
  type: ApplicationCommandTypes.ChatInput,
  scope: 'Global',
  options: [
    {
      name: 'file',
      description: 'Demo file.',
      type: ApplicationCommandOptionTypes.Attachment,
      required: true,
    },
  ],
  execute: async (bot: DiscordBot, interaction: DiscordInteraction) => {
    const attachment = interaction.data?.resolved?.attachments?.first()!;
    const warnFileIsTooBigForRender = attachment.size > Server.config.maxDemoFileSize;

    await bot.helpers.sendInteractionResponse(
      interaction.id,
      interaction.token,
      {
        type: InteractionResponseTypes.ChannelMessageWithSource,
        data: {
          content: `⏳️ Fixing file...`,
        },
      },
    );

    try {
      const res = await fetch(attachment.url, {
        method: 'GET',
        headers: {
          'User-Agent': Deno.env.get('USER_AGENT')!,
        },
      });

      if (!res.ok) {
        await bot.helpers.editOriginalInteractionResponse(interaction.token, {
          content: `❌️ Unable to download attachment.`,
        });
        return;
      }

      const buffer = await res.arrayBuffer();

      const parser = SourceDemoParser.default()
        .setOptions({
          dataTables: true,
          stringTables: true,
        });

      const demo = parser.parse(buffer);

      // NOTE: The code here should be similar to autoFixupOldPortal2Demo in src/server/demo.ts

      if (demo.gameDirectory !== 'portal2' && demo.gameDirectory !== 'Portal 2 Speedrun Mod') {
        await bot.helpers.editOriginalInteractionResponse(interaction.token, {
          content: `❌️ Only Portal 2 demos require a fixup.`,
        });
        return;
      }

      const dt = demo.findMessage(Messages.DataTable)?.dataTable;
      if (!dt) {
        console.error(`DataTable message not found in demo.`);
        await bot.helpers.editOriginalInteractionResponse(interaction.token, {
          content: `❌️ Unable to parse demo.`,
        });
        return;
      }

      const fixedFileName = attachment.filename.toLowerCase().endsWith('.dem')
        ? `${attachment.filename.slice(0, -4)}_fixed.dem`
        : `${attachment.filename}_fixed`;

      // Full fixup: coop partner, point_survey and stale signon. Falls back to the
      // point_survey-only fixup below for demos it cannot handle.
      try {
        const result = fixupDemo(new Uint8Array(buffer));

        if (!result) {
          await bot.helpers.editOriginalInteractionResponse(interaction.token, {
            content: `❌️ This demo does not require a fixup because it was played on the latest version.`,
          });
          return;
        }

        const fixes = [
          result.coop && 'coop partner',
          result.pointSurvey && 'point_survey',
          result.staleSignon && `wrong map (${result.staleSignon.from} → ${result.staleSignon.to})`,
        ].filter(Boolean);

        await bot.helpers.editOriginalInteractionResponse(interaction.token, {
          content: `🔨️ Fixed old demo (${fixes.join(', ')}).` +
            (warnFileIsTooBigForRender ? `\n⚠️ Detected that the file is too big for a render.` : ''),
          files: [
            {
              blob: new Blob([new Uint8Array(result.data)]),
              name: fixedFileName,
            },
            {
              blob: new Blob([buffer]),
              name: attachment.filename,
            },
          ],
        });
        return;
      } catch (err) {
        if (!(err instanceof DemoFixupError)) throw err;
        console.error(`demofixup failed, falling back to the point_survey fixup: ${err.message}`);
      }

      const wasFixedBefore = dt.serverClasses.filter((table) => table.className === 'CPointCamera').length === 2;
      const fixup = fixupPointSurvey(demo);

      if (fixup.result === 'not-needed') {
        await bot.helpers.editOriginalInteractionResponse(interaction.token, {
          content: wasFixedBefore
            ? `❌️ This demo has been fixed already.`
            : `❌️ This demo does not require a fixup because it was played on the latest version.`,
        });
        return;
      }

      if (fixup.result === 'unfixable') {
        await bot.helpers.editOriginalInteractionResponse(interaction.token, {
          content: `❌️ Unfortunately this demo cannot be fixed.`,
        });
        return;
      }

      demo.writeDataTables();

      const fixed = parser.save(demo, buffer.byteLength + fixup.extraBytes);

      await bot.helpers.editOriginalInteractionResponse(interaction.token, {
        content: `🔨️ Fixed old demo.` +
          (warnFileIsTooBigForRender ? `\n⚠️ Detected that the file is too big for a render.` : ''),
        files: [
          {
            blob: new Blob([new Uint8Array(fixed)]),
            name: fixedFileName,
          },
          {
            blob: new Blob([buffer]),
            name: attachment.filename,
          },
        ],
      });
    } catch (err) {
      console.error(err);

      await bot.helpers.editOriginalInteractionResponse(interaction.token, {
        content: `❌️ Failed to fix demo.`,
      });
    }
  },
});
