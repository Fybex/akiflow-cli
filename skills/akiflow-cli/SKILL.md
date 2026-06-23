---
name: akiflow-cli
description: Manage Akiflow tasks from CLI. Use when creating, listing, completing tasks, managing projects, or viewing calendar/time blocks. Credential extraction from browser—no API keys needed.
metadata: {"openclaw":{"emoji":"📋","requires":{"bins":["af"]}}}
---

# Akiflow CLI

Manage [Akiflow](https://akiflow.com) tasks directly from the command line.

## Why use this?

| Feature | Web App | Akiflow CLI |
|---------|---------|-------------|
| Speed | Browser-based | **Instant from terminal** |
| OAuth setup | N/A | **Not needed** |
| API keys | N/A | **Not needed** |
| Credential source | Manual login | Browser token extraction |

Use this when you want fast task management without leaving your terminal.

## Setup

바이너리 설치됨: `/opt/homebrew/bin/af` (또는 `which af`)

최초 인증:
```bash
af auth        # Chrome에서 토큰 자동 추출
af auth status # 인증 상태 확인
```

Credentials 저장 위치: `~/.config/af/credentials.json`

---

## 토큰 만료 대처 (중요!)

### 자동 갱신
- CLI가 refresh token으로 자동 갱신 시도
- 대부분의 경우 사용자 개입 없이 작동

### 수동 재인증이 필요한 경우

**증상:**
- `AuthError: No credentials found` 에러
- `401 Unauthorized` 응답  
- API 호출 실패

**대처 순서:**

1. **먼저 Chrome에서 Akiflow 로그인 확인**
   ```bash
   # Chrome에서 https://web.akiflow.com 접속하여 로그인 상태 확인
   # 로그아웃 되어있으면 로그인
   ```

2. **토큰 재추출**
   ```bash
   af auth
   # "Found 1 token(s) from: chrome" 메시지 확인
   ```

3. **인증 상태 확인**
   ```bash
   af auth status
   # "Authenticated" 출력되면 성공
   ```

4. **여전히 실패 시**
   - Chrome 완전히 종료 후 재시작
   - Akiflow 웹에서 로그아웃 → 재로그인
   - `af auth` 다시 실행

### 에러별 대처

| 에러 | 원인 | 해결 |
|------|------|------|
| `No credentials found` | 토큰 없음 | `af auth` 실행 |
| `Token expired` | 만료됨 | Chrome에서 Akiflow 접속 후 `af auth` |
| `401 Unauthorized` | 토큰 무효 | 위와 동일 |
| `Network error` | 네트워크 | 인터넷 연결 확인 |

---

## Authentication

```bash
af auth                # Extract credentials from browser
af auth status         # Check auth status
```

---

## Task Commands

### List Tasks

```bash
af ls                      # List today's tasks
af ls --inbox              # List inbox (unscheduled tasks)
af ls --project "Work"     # List by project
af ls --all                # List all tasks
```

### Add Tasks

```bash
af add "Task title"                          # Add to inbox
af add "Task title" -t                       # Add for today
af add "Task title" -d "tomorrow"            # Natural language date
af add "Task title" -d "next friday 10am"    # Specific date/time
af add "Task title" --duration "2h"          # With duration
af add "Task title" --project "Work"         # Assign to project
```

**Grid block sizing:** `--at` + `--duration` creates a visible time slot on the calendar grid. The slot is sized to the task's duration (or 30m if unset). Stacking parallel tasks in one slot: first task creates the slot, additional tasks use `--slot <slot-id>`.

### Complete Tasks

```bash
af do 1                    # Complete by short ID (requires af ls first)
af do "full-uuid-here"     # Complete by full UUID
```

### Edit Tasks

```bash
af task edit 1 --title "New title"       # Edit title
af task move 1 --project "Personal"      # Move to project
af task plan 1 -d "tomorrow"             # Reschedule
af task plan 1 --at 14:00                # Reschedule + set time (preserves duration)
af task snooze 1 --duration "2h"         # Snooze
af task delete 1                         # Soft delete
af task unschedule 1                     # Remove from time slot (keeps it on the day)
af task unschedule 1 --delete-slot       # Also soft-delete the now-empty slot
```

**Reschedule behavior:** `task plan --at` reads the task first to preserve its duration and reuses the existing time-slot ID (no orphan slots, no 30m default). To move to a different time on a fresh slot, pair with the reschedule workflow in [[#Time Blocking]].

**Soft delete quirk:** `task delete` must send `status: 2` alongside `deleted_at` — PATCH with `deleted_at` alone is silently dropped, the row stays visible. The CLI handles this; if you script direct PATCH calls, send both fields.

---

## Project Commands

```bash
af project ls                    # List all projects
af project create "Project Name" # Create new project
af project delete "Project Name" # Delete project
```

---

## Calendar & Time Blocking

```bash
af cal                           # View today's schedule
af cal --free                    # Find free time slots
af cal -d "tomorrow"             # View specific date

af block 1h "Focus time"         # Create 1-hour time block
af block 2h "Meeting prep" --start "14:00"  # With start time

af slot ls                       # List today's time slots
af slot ls -d 2026-06-25         # List slots for a specific date
af slot delete <id>              # Delete a slot (refuses if tasks are stacked)
af slot delete <id> --force      # Delete even with stacked tasks (orphans their time_slot_id)
```

**Stacking parallel tasks in one slot:** first task uses `--at --duration` (creates the slot), additional tasks use `--slot <slot-id>`:

```bash
af add "Task A" --at 15:30 --duration 90m --project work
af add "Task B" --slot <slot-id>
```

Don't create slots for single quick tasks. If it's a 15m reminder (routines, errands), use `af add -t` (today list, no grid block).

---

## Short ID System

Running `af ls` saves task context to `~/.cache/af/last-list.json`. This enables short IDs:

```bash
af ls                # Shows: [1] Task A, [2] Task B, ...
af do 1              # Completes Task A
af task edit 2 --title "Updated"  # Edits Task B
```

Full UUIDs always work as fallback.

---

## Common Workflows

### Morning Task Review

```bash
af ls                          # See today's tasks
af ls --inbox                  # Check inbox for unscheduled items
af task plan 3 -d "today"      # Schedule an inbox item for today
```

### Quick Task Capture

```bash
af add "Review PR #123" -t     # Add to today
af add "Follow up with client" -d "monday"  # Schedule for next week
```

### End of Day

```bash
af ls                          # Review remaining tasks
af task snooze 2 --duration "1d"   # Push to tomorrow
af do 1                        # Mark as done
```

### Time Blocking

```bash
af cal --free                  # Find available slots
af block 2h "Deep work" --start "09:00"
af block 1h "Email" --start "14:00"
```

### Project Management

```bash
af project ls                  # List projects
af ls --project "Work"         # View project tasks
af add "New feature" --project "Work" -d "friday"
```

---

## Natural Language Dates

Supported formats:
- `today`, `tomorrow`, `yesterday`
- `monday`, `tuesday`, ... (next occurrence)
- `next week`, `next month`
- `in 2 hours`, `in 3 days`
- `march 15`, `2026-03-15`
- `friday 10am`, `tomorrow 14:00`

---

## Output Format

All commands output human-readable format by default.

---

## Troubleshooting

### Token Expired

```bash
af auth                # Re-extract from browser
af auth status         # Verify authentication
```

### Short IDs Not Working

```bash
af ls                  # Refresh task cache first
af do 1                # Now works
```
