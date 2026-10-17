# Autorender API

Public, read-only endpoints for tools such as the board integrations, Discord bots and launcher plugins.

Base URL: `https://autorender.portal2.sr/api/v1`

Errors are returned as JSON with the HTTP status, e.g. `{ "status": 400, "message": "Bad value for source parameter." }`.

## Boards

Several endpoints take a `source` parameter that selects leaderboards:

| Value                       | Board                                           |
| --------------------------- | ----------------------------------------------- |
| `portal2` (`p2`, `cm`, `1`) | [board.portal2.sr](https://board.portal2.sr)    |
| `mel` (`2`)                 | [mel.portal2.sr](https://mel.portal2.sr)        |
| `lphub` (`lp`, `3`)         | [lp.portal2.sr](https://lp.portal2.sr) (LP Hub) |

Portal 2 and Mel runs are identified by their changelog ID (number). LP Hub runs are identified by their demo ID (UUID).

## Search leaderboard runs

`GET /search`

Searches rendered leaderboard runs, newest first.

| Parameter | Description                                                         |
| --------- | ------------------------------------------------------------------- |
| `q`       | Search text, see below. Without it the latest runs are returned.    |
| `source`  | Comma-separated boards, e.g. `portal2,mel`. Defaults to all boards. |
| `limit`   | Number of results, 1-50. Defaults to 20 (30 without `q`).           |
| `offset`  | Number of results to skip for paging, 0-10000. Defaults to 0.       |

Search syntax for `q`:

- `<map>`, e.g. `portal gun`
- `<map> wr` or `<map> world record`: rank 1 runs
- `<map> 2nd`, `<map> rank 3`: runs of a rank
- `<map> 1:23.45` or `<map> 16.78`: runs with that time
- `<map> <player>` or `<player> <map>`
- `sp`, `coop`, `blue` (host) or `orange` (partner) before the rank/time narrows the map type

Response:

```json
{
  "end": false,
  "results": [
    {
      "share_id": "qYmfHKSp4iI",
      "title": "Bridge Intro in 18.51 by Burger40",
      "board": "portal2",
      "source": "board.portal2.sr",
      "id": 357487,
      "changelog_id": 357487,
      "demo_id": null,
      "map": "Bridge Intro",
      "map_id": 47752,
      "board_map_id": null,
      "time": 1851,
      "portals": 5,
      "orig_rank": 1,
      "user": "Burger40",
      "user_id": "76561198083196477",
      "comment": "monument",
      "date": "2026-10-07T14:26:00.000Z",
      "views": 120,
      "video_url": "https://autorender.portal2.sr/storage/videos/qYmfHKSp4iI",
      "thumbnail_url": "https://autorender.portal2.sr/storage/thumbnails/qYmfHKSp4iI",
      "cur_rank": 0,
      "obsoleted": 0
    }
  ]
}
```

| Field                        | Description                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `end`                        | `true` when there are no more results after this page.                                                  |
| `share_id`                   | Video ID: `https://autorender.portal2.sr/videos/<share_id>`.                                            |
| `board`                      | `portal2`, `mel` or `lphub`.                                                                            |
| `source`                     | Domain of the board.                                                                                    |
| `id`                         | Changelog ID (Portal 2, Mel) or demo ID (LP Hub). Kept for compatibility, prefer the two fields below.  |
| `changelog_id`               | Changelog ID of Portal 2 and Mel runs, otherwise `null`.                                                |
| `demo_id`                    | Demo ID of LP Hub runs, otherwise `null`.                                                               |
| `map`                        | Map name.                                                                                               |
| `map_id`                     | Chamber ID on board.portal2.sr / mel.portal2.sr.                                                        |
| `board_map_id`               | Map ID on LP Hub (`https://lp.portal2.sr/maps/<board_map_id>`), `null` for other boards and older runs. |
| `time`                       | Time in centiseconds.                                                                                   |
| `portals`                    | Portal count of the run.                                                                                |
| `orig_rank`                  | Rank on its board when the run was submitted. On LP Hub the rank is by portal count.                    |
| `user`, `user_id`            | Player name and Steam ID.                                                                               |
| `video_url`, `thumbnail_url` | Video file and thumbnail.                                                                               |
| `cur_rank`, `obsoleted`      | Always `0`, kept for compatibility.                                                                     |

## Split times of a run

`GET /mtriggers/search`

Returns the split times (SAR mtriggers) of the latest run of a rank on a map, optionally together with a player's PB. Portal 2 and Mel runs only.

| Parameter       | Description                                       |
| --------------- | ------------------------------------------------- |
| `game_dir`      | Required, e.g. `portal2` or `portal_stories`.     |
| `map_name`      | Required, e.g. `sp_a2_bridge_intro`.              |
| `board_rank`    | Required, rank 1 or higher.                       |
| `include_pb_of` | Optional Steam ID: also return that player's run. |

Response: `{ "data": [{ "board_changelog_id", "board_profile_number", "board_rank", "demo_metadata": { "segments": [...] } }], "count": 1 }`

## Check which runs have a video

`POST /check-videos-exist`

Body: `{ "ids": [357487, 357488], "source": "portal2" }`

- `ids`: up to 500 changelog IDs, or demo IDs for LP Hub.
- `source`: one board, defaults to `portal2`. Can also be passed as `?source=`.

Response: `{ "ids": [357487] }`, the IDs that have a rendered video.

## Redirect to the video of a run

`GET /video/<id>/video?source=1`

Redirects to the video file of a run. `<id>` is the changelog ID, or the demo ID with `source=3` (LP Hub). `source` defaults to `1` (Portal 2) and only takes numbers here.

## Other endpoints

| Endpoint                               | Description                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /videos/random/<count>`           | 1-10 random rendered videos: `[{ "share_id", "title" }]`.                               |
| `GET /videos/status/<discord_user_id>` | The latest 5 renders requested by a Discord user with `rendered`/`rendering`/`errored`. |
| `GET /videos/embed/<share_id>`         | Redirects to the video file.                                                            |

Endpoints for uploading, rendering, rerendering and deleting videos are used by the render clients, the bot and the website and are not meant for other tools.
