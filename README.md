# 2firsts-feishu-bot
Push 2Firsts daily report to Feishu
# 2firsts-feishu-bot

Push 2Firsts CN content to Feishu groups with GitHub Actions.

## Overview

This repository sends a Feishu rich-text message titled `2F daily report`.

The sender supports two content paths:
- `report_detail`: If `https://cn.2firsts.com/report/detail?date=YYYY-MM-DD` exists and contains parsed morning-report items, the message uses that report page directly.
- `latest_48h`: If the dated report page returns `404` or cannot be parsed, the message falls back to articles published within the latest 48 hours.

Each run writes preview artifacts to `preview/` so the extracted content can be inspected even when Feishu sending is skipped or fails.

## Schedule

The workflow is defined in `.github/workflows/daily.yml` and currently runs twice per day:
- Beijing `09:30` -> send to Feishu group `A`
- Beijing `10:30` -> send to Feishu group `B`

GitHub Actions cron uses UTC, so the workflow stores these schedules as:
- `30 1 * * *` -> `09:30` Asia/Shanghai
- `30 2 * * *` -> `10:30` Asia/Shanghai

Note: GitHub `schedule` jobs can be delayed. The actual execution time in Actions may be later than the configured cron time.

## Required Secrets

Add these repository secrets in `Settings -> Secrets and variables -> Actions`:

- `FEISHU_WEBHOOK_A`
- `FEISHU_WEBHOOK_B`
- `FEISHU_SECRET_A`
- `FEISHU_SECRET_B`
- `FEISHU_KEYWORD_A`
- `FEISHU_KEYWORD_B`

If A and B use the same keyword or secret, you can still store them separately to keep the workflow logic simple and explicit.

## Manual Run

Use `Actions -> Push 2Firsts Daily Report -> Run workflow`.

Inputs:
- `target_date`: Optional. Format `YYYY-MM-DD`. Leave blank to use the current day in `Asia/Shanghai`.
- `preview_only`: `true` only generates preview artifacts and does not send to Feishu. `false` actually sends the message.
- `target_group`: Choose `A` or `B` for manual runs.

Expected behavior:
- `preview_only=true`: The run can still succeed, but `send.status` will be `skipped` and no message will be pushed.
- `preview_only=false`: If the run finishes with `success`, Feishu sending should already have succeeded.

## Message Rules

- The message title is fixed as `2F daily report`.
- If the dated morning report page is available, the message content follows the report page order and uses the report-linked article URLs as source-article hyperlinks.
- If the dated morning report page is unavailable or unparsable, the sender falls back to the latest 48-hour article window.
- Group A and group B run independently, so if the source site changes between `09:30` and `10:30`, the two groups may receive slightly different content. This is expected.

## Preview Artifacts

Every run uploads a preview artifact named like:
- `2firsts-preview-A`
- `2firsts-preview-B`

Key files:
- `preview/latest.log`: Runtime logs
- `preview/latest.json`: Structured run result and send diagnostics
- `preview/latest.md`: Human-readable preview summary

Important fields in `preview/latest.json`:
- `pushTarget`: Which group this run targeted, for example `A` or `B`
- `contentSource`: `report_detail` or `latest_48h`
- `previewOnly`: Whether this run intentionally skipped sending
- `send.status`: `sent`, `skipped`, or `failed`
- `send.reason`: The direct reason for skip or failure
- `send.responseCode`: HTTP response code returned by Feishu when a send attempt happens

## Troubleshooting

If a run succeeds but no Feishu message appears, check these fields first:
- `preview/latest.json -> previewOnly`
- `preview/latest.json -> send.status`
- `preview/latest.json -> send.reason`
- `preview/latest.json -> pushTarget`
- `preview/latest.json -> contentSource`

Typical cases:
- `previewOnly=true` and `send.status=skipped`: preview mode was enabled, so nothing was sent.
- `send.status=failed`: the workflow tried to push, but Feishu rejected the request or the webhook call failed.
- `send.status=sent`: Feishu returned success. If no message appears, verify that the correct bot and target group were configured.

## Local Notes

Main files:
- `report-run.js`: Fetch, extract, build preview artifacts, and send Feishu messages
- `.github/workflows/daily.yml`: Schedule, manual inputs, and A/B group secret resolution
- `index.js`: Older sender implementation kept in the repository for reference
