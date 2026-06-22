<div align="center">

# Akiflow CLI (Fork)

**Command-line interface for [Akiflow](https://akiflow.com) task management**

Fork of [code-yeongyu/akiflow-cli](https://github.com/code-yeongyu/akiflow-cli) with time slot support, unified daily view, and recurring task editing.

</div>

---

Bun-native CLI for managing Akiflow tasks from the terminal. Built with TypeScript, [citty](https://github.com/unjs/citty), compiles to a standalone `af` binary.

## Fork changes

### Time slots (grid blocks)

The upstream CLI set `calendar_id` + `status:2` directly on tasks, which did not produce visible calendar grid blocks in Akiflow. This fork creates `time_slot` records via `PATCH /v5/time_slots` (matching the web app's pattern), then links tasks via `time_slot_id`.

```bash
# Grid block (creates a time_slot)
af add "Focus work" --at "15:30" --duration "90m"

# Stack parallel tasks into one slot
af add "Task A" --at "15:30" --duration "90m" --project work   # creates slot
af add "Task B" --slot <slot-id>                               # joins same slot

# List / delete slots (find orphans)
af slot ls
af slot delete <id>
```

### Unified daily view (`af today`)

Replaces the broken `af cal`. Shows events, time slots with stacked tasks, and unslotted tasks in one time-sorted view:

```
📅 Monday, Jun 22

⏱ 09:00→09:30  (30m)
   ○ Plan the day ↻
⏱ 14:00→16:00  (2h)
   ○ Write report
   ○ Review PRs
📌 16:00→16:30  Team standup (30m) ↻

📋 Today (no time block):
   ○ Buy groceries
   ○ Call dentist
```

### Recurring task editing (`af task edit --scope`)

Edit recurring tasks per-occurrence or whole-series:

```bash
af task edit <id> --scope this      --date 2026-06-22 --desc "Today's plan"
af task edit <id> --scope all       --title "New title"
af task edit <id> --scope following --date 2026-07-01 --title "From July onward"
```

### Other fixes

- `af task plan --at` now creates a time_slot (was setting datetime without a grid block)
- `af block` fixed to use slot creation (was using the old calendar_id approach)
- `getDefaultCalendarId` uses `resolveCalendar` (akiflow-primary lookup) instead of fragile time-slot[0] approach
- `af add --no-slot` flag for timed tasks without grid blocks (experimental — API may auto-create slots)
- `af add --project` sets `label_id` on the slot, not just `listId` on the task
- Removed `af cal` (replaced by `af today`) and `af hello` (placeholder)

## Commands

```
af today                    Unified daily view (events + slots + tasks)
af ls [--inbox|--all|--search|--project|--json]   List tasks
af add "Title" [--at|--duration|--slot|--no-slot|--project|--due|--desc|--link|--recurrence]
af do <id>                  Complete task
af task edit <id> [--scope this|following|all] [--title|--due|--desc|--link|--recurrence]
af task move <id> --project <name>
af task plan <id> [--date|--at]
af task snooze <id> --duration <dur>
af task delete <id>
af block <duration> <title> Auto-slot into next free time
af slot ls [--date YYYY-MM-DD]
af slot delete <id>
af event ls [--search|--days|--date|--all|--json]
af event add "Title" --at <time> [--duration|--calendar|--color|--recurrence]
af event delete --id <uuid>
af project ls|create|delete
af auth|auth status
af cache
```

## Installation

### Prerequisites

- [Bun](https://bun.sh) v1.0+

### From source

```bash
git clone https://github.com/Fybex/akiflow-cli.git
cd akiflow-cli
bun install
bun run build
mv af /usr/local/bin/
```

### Development

```bash
bun run start          # Run directly
bun run dev            # Hot reload
bun test               # Run tests
bunx tsc --noEmit      # Type check
```

## Authentication

```bash
af auth         # Extract session token from browser
af auth status  # Check auth status
```

Supports Chrome, Firefox, Safari, Arc, Brave, Edge. Credentials stored in `~/.config/af/credentials.json` with automatic token refresh.

## Architecture

```
src/
├── index.ts              CLI entry point
├── commands/
│   ├── today.ts          Unified daily view
│   ├── add.ts            Task creation (slots, stacking, recurrence)
│   ├── ls.ts             Task listing
│   ├── do.ts             Complete tasks
│   ├── task/index.ts     edit/move/plan/snooze/delete
│   ├── slot.ts           Slot ls + delete
│   ├── block.ts          Auto-slot into free time
│   ├── event.ts          Calendar events
│   ├── project.ts        Labels/projects
│   ├── auth.ts           Browser token extraction
│   ├── cache.ts          Local cache management
│   └── completion.ts     Shell completions
├── lib/
│   ├── api/              Akiflow API client + types
│   ├── auth/             Token extraction & storage
│   ├── calendar.ts       Calendar resolution
│   ├── date-parser.ts    chrono-node wrapper
│   ├── duration-parser.ts
│   ├── rrule.ts          RRULE helpers
│   └── task-cache.ts     Pending task cache
└── __tests__/
```

## License

MIT
