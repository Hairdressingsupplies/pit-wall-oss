# Pit Wall

Mission control for the Claude Code sessions on this PC. One page shows every session, grouped
into projects Claude names and keeps up to date, flags the ones waiting on you (and sends a
Windows notification), and lets you chat with any of them — approvals, questions and images
included — without hunting for a terminal. It also runs a background job queue, standing
"agents", and shows your Windows scheduled jobs.

Local only: `http://127.0.0.1:4040`. Windows only for now (notifications, scheduled jobs and the start-up shortcut use Windows).

## Quick start

You need Windows, [Node.js](https://nodejs.org) 24 or newer, git, and [Claude Code](https://claude.com/claude-code)
installed and logged in. There is no `npm install`: Pit Wall has no dependencies.

```powershell
cd $HOME\Documents\GitHub
git clone https://github.com/Hairdressingsupplies/pit-wall-oss.git pit-wall
cd pit-wall
node src/setup.mjs --name "Your name" --automation
```

Clone into a folder called **`pit-wall`** (the last argument above): the installer and the hooks look for that name,
and a plain `git clone` would name it `pit-wall-oss`. `--automation` turns on the background **Queue** and **Agents**;
leave it out for a chat-and-board-only install. Setup checks everything first, then opens http://127.0.0.1:4040.
`node src/setup.mjs --check` re-runs the checks; `--uninstall` undoes it (see below).

### What it changes on your PC

- **Adds six hooks** to your global Claude settings (`~/.claude/settings.json`), after saving a copy as
  `settings.json.bak-pitwall-<date>`. Your other hooks are kept. See **The status hook** below.
- **Adds a Startup shortcut**, so Pit Wall starts hidden when you log in.
- **Reads** your Claude Code transcripts (`~/.claude/projects`) and live sessions (`~/.claude/sessions`) to build the
  board. It never edits them.
- **Runs your own `claude.exe`** for each chat on your normal login, in Claude Code's **auto mode**. It never uses
  bypass-permissions, and you can change a chat's permissions.
- **Makes small background Claude calls** on your subscription: naming sessions (Haiku), sorting them into projects,
  and a one-word Haiku probe that reads your usage limits. It also runs `git fetch` to check GitHub for updates.
- **Stores its own state only in `data/`** inside the repo (database, logs, settings), which is git-ignored. The page
  listens on 127.0.0.1 only; reaching it from another PC is opt-in (see **Use it from another PC**).

`node src/setup.mjs --uninstall` removes the hooks and the Startup shortcut and stops the server. It leaves `data/`
alone; delete the folder to remove everything.

## Run it

Pit Wall **starts by itself when you log in** (a shortcut in your Windows Startup folder runs
`start-hidden.vbs`, which starts the server with no window). Just open http://127.0.0.1:4040 —
or double-click **`Pit Wall.cmd`**, which starts it if needed and opens the page.
Needs Node 24+ and Claude Code logged in. No `npm install` — there are no dependencies.
The server log is `data/server.log`.

**Folders** — New session, Queue and Agents offer a dropdown of folders: the workspace (default
`Documents\GitHub`) and each git folder directly inside it, plus **Other folder…** to type any path. The last
folder you used is remembered. Each PC sets its own in `data/local.json` (git-ignored; restart to apply):

```json
{ "workspace": "C:\\Code", "folders": ["D:\\Projects\\website"] }
```

`folders` adds ones outside the workspace or without a `.git`. `PITWALL_WORKSPACE` / `PITWALL_FOLDERS` (`;`-separated) override it.

The same file says whose Pit Wall it is:

| Key | Default | What it does |
|---|---|---|
| `name` | `site.json` `owner`, else your Windows user name | The name in the prompts Pit Wall sends Claude and on the page |
| `about` | `site.json` `about` | One line after the name in the organiser prompt, e.g. `"works at Acme on marketing and email."` |
| `automation` | `true` | `false` switches the **Queue** and **Agents** off completely: nothing runs, and they are hidden everywhere |

### `site.json` (optional, for a team sharing one copy of the repo)

Settings that are the same for everyone who runs your copy go in `site.json` at the repo root. Commit it in your
own fork; per-PC settings stay in `data/local.json`, which wins where both set something. All keys are optional:

```json
{
  "owner": "Sam", "ownerTheir": "her",
  "about": "runs Acme: an online shop, a warehouse app and the marketing.",
  "company": "Acme",
  "roundupTo": "sam@example.com", "roundupToName": "Sam", "roundupToLabel": "Sam, who runs Acme",
  "liveSystems": "Shopify/Stripe",
  "jobBlockedCommands": ["php artisan migrate --force"],
  "dangerRules": [{ "label": "Live database", "pattern": "db\\.example\\.com", "flags": "i" }]
}
```

`owner`/`about` describe the person whose PC has no `name` in local.json; team installs default to "works at
<company>." `dangerRules` add red approval badges for your own servers and APIs, `jobBlockedCommands` add hard blocks
for queued jobs, and `liveSystems` names what queued jobs are told never to change.

## Set up on another PC

Clone the repo into a folder named `pit-wall` (see **Quick start**) and run
`node src/setup.mjs --name … --about … --workspace … [--automation]`.
Double-clicking **`Setup Pit Wall.cmd`** does the same and asks for anything missing. The installer:

- checks Node 24+, that Pit Wall can start Claude Code, and that Claude is logged in;
- writes `data/local.json` (`automation: false` unless you pass `--automation`);
- backs up `~/.claude/settings.json`, then adds the six hooks (re-running never duplicates them, and other hooks are kept);
- adds the Startup shortcut, starts Pit Wall and opens the page.

The nightly review and remote access are never set up on team PCs. `--check` re-runs the checks. `--uninstall` removes the hooks
and its own Startup shortcut, and stops the server on its port; it never touches `data/`. To update: `git pull`, then
`Restart Pit Wall.cmd`.

To stop it: end the `node.exe` running `src\server.mjs` in Task Manager. Chats keep running under their
relays (see **Restarts**) and are picked up when it starts again; to end a chat, Finish or Stop it in Pit Wall.
After a PC restart, anything that was cut off mid-step shows as **Interrupted** with a **Continue** button.
To stop it starting at login: delete **Pit Wall** from `shell:startup`.

## What it does

- **Sessions board** — live terminals (`~/.claude/sessions/*.json`), Pit Wall's own sessions, and the
  last 14 days of transcripts. "Needs you" is exact for Pit Wall sessions, and exact for terminals
  started after the status hook was installed (see below); terminals that were already open fall
  back to a labelled best guess until they are restarted.
- **Notifications** — a Windows notification when a Pit Wall session asks for approval, asks a
  question, finishes or errors; when a terminal is waiting on a permission prompt or question (not
  after every reply); and once after a restart if sessions were cut off. Click it to open that chat.
  Not sent for the chat you are looking at; switch off with the header button.
- **Chat** — runs your own `claude.exe` per session (`-p` stream-json, `--resume`) in the session's
  folder, on your normal login, with your usual CLAUDE.md, memory, skills, plugins, hooks, MCP
  connectors, Chrome and slash commands. Pit Wall passes what a terminal gets automatically but
  headless mode doesn't: **auto mode** (headless ignores `defaultMode`), **medium effort**, and
  **Claude in Chrome**. Per session you can change model, effort and permissions. Never
  bypass-permissions. File edits show as a red/green before-and-after; subagent steps nest under
  the call that started them; **Load earlier** pages back through long conversations.
- **Agents and workflows** — while a chat's background agents or a workflow are still running it
  shows as **agents working** (no "your turn", no notification) and the header names what is
  running; "your turn" comes once, after the last one finishes and Claude has replied. An Agent
  call shows the agent's steps and its report; a Workflow call shows its phases and each agent's
  state, live. Both are rebuilt from the agent files when you reopen a chat. Above the message box, one
  **agents panel** lists every running agent, plain or in a workflow: a one-line summary (working · quiet
  · failed · workflow progress) that opens into a scrolling list, with failed and quiet agents first,
  what each is doing in words, and Stop on hover (Stop all asks twice). Click any agent, there or under its
  Agent call, for its full view: prompt, every step with input and result, and its report. On a chat Pit Wall runs, Finish and End session
  ask twice while agents are running (they would be stopped), and Move here is refused until a
  terminal's agents have finished. A background shell command (a dev server) does not count.
  Not counted yet: agent and workflow tokens in the usage figures.
- **Restarts** — each chat's `claude.exe` runs under its own small detached relay (`src/relay.mjs`), not as a
  child of the server, so restarting Pit Wall doesn't cut it off: mid-reply work, agents and questions waiting
  for approval carry on, and the new server picks each chat up (`Picked up N running chats` in the log) by
  replaying the relay's log (`data/relays/<id>.log` — what Claude said and what Pit Wall answered), with no
  repeat notifications. Only a PC restart (or killing a relay) cuts a chat off; it then shows as Interrupted.
  Idle chats Pit Wall had parked come back on the board as resting; send a message to carry on. They drop to
  Closed when you Finish them or after 3 days untouched. `PITWALL_NO_RELAY=1` runs chats as direct children
  (the old way). ⚠ Testing a server on a copy of `data/`: leave `relays/` out of the copy.
- **`! command`** — like the terminal's bash mode (headless Claude Code doesn't have one): `! docker ps` in a
  chat runs the command in the session's folder (Git Bash, 10-minute limit, no input) and shows the output as it
  arrives, with a **Stop** button while it runs — so `! gh auth login` shows its code and link straight away. It
  costs no turn — Claude sees the command and its output with your next message, as in the terminal.
- **Images** — paste, drop or attach up to 6 PNG/JPEG/GIF/WebP per message (chat or New session).
  Anything over 2000 px or 3.5 MB is scaled down in the browser first.
- **Files** — drop or attach any other file: a chip shows it, and the message tells Claude where it is. Dragged from
  Explorer on this PC it keeps its own path (Claude can work on the real file); otherwise (no path, or remote) a copy
  is uploaded to `data/uploads/<chat>/` (50 MB each, 10 per message).
- **Like the terminal** (Pit Wall-run chats):
  - **btw** — side questions answered from the chat with no tools; nothing is added to it; works while Claude is busy.
  - **Fork** — "Fork from here" under a reply that ended its turn, or Fork… in the chat menu: a new chat carries on from
    there; the original is untouched ("allow for this session" grants are not carried over).
  - **Rewind to here** — under your messages: that message and everything after leave the chat, the text comes back to
    edit, and Claude's file edits since can be undone too (chats started after 2026-10-06; Bash changes aren't covered).
  - **Queued messages** — sent while Claude works: marked Queued with **Take back** and **Send now** (interrupts).
  - **Plans** — plan-mode approval shows the plan formatted, with Approve — auto / accept edits / ask each time, or Keep
    planning with feedback.
  - **Background tasks** — a strip lists each (commands too) with **Stop** for just that one.
  - **Mode and model** switch at once while Claude runs; **thinking** text shows folded under "Thinking".
- **Colours** — give a chat a colour in its More menu; its row on the board keeps it until you clear it.
- **Terminal sessions** — shown read-only. **Move here** ends Claude in that terminal window
  (only when it is idle, and only after checking the process ID *and* its start time, so a reused
  PID is never touched) and the conversation carries on in Pit Wall.
- **Projects** — a cheap isolated Haiku call (no tools, no MCP, nothing saved) files sessions into
  descriptively named projects and keeps each project's checklist. New sessions are filed within
  a couple of minutes; filed ones are revisited at most once per hour of activity. Capped at 40
  calls a day. Anything you set by hand is locked from it.
- **Continuing tasks** — each project task has **Open chat** (the chat it came from; for tasks made
  before that was recorded, the project's only chat) and **Start** / **Continue**, which opens New
  session pre-filled with a brief: the task, the project goal, the checklist and what the last few
  chats said. You read and edit it before anything starts. A project's **Continue** reopens its
  latest live chat, or briefs a new one if none is open.
- **Task status → the chat** — when you change a task's status, a strip under it lets you say what
  Done means (**Deployed** / **Finished** / your own note). The chat the task came from (or the
  project's latest chat) is told on your next message there — terminal or Pit Wall — by a
  `UserPromptSubmit` hook (`src/hook-inbox.mjs`, ~70 ms, no extra turn), and asked to bring its memory
  and vault notes in line. **Tell it now** sends it at once (one turn of usage). Hover a task's status
  for its history; the day's changes also go in `data/activity/`.
- **Finishing** — **Finish** in a chat's header ends it (Pit Wall-run chats only; a terminal window is
  left alone), takes it off the board and out of "Needs you", and files it under Closed. Any new
  activity — or **Reopen** — brings it back. **Finish project** (shown on the card once every task is
  done, otherwise in its ••• menu) closes the project and all its chats; it moves to a collapsed
  *Finished projects* section with **Restore**.
- **Restarting** — double-click `Restart Pit Wall.cmd`. When the running server has relays (it writes its PID to
  `data/relays/supported.txt`) it restarts at once — chats keep going, including the one that asked for the
  restart. With an older server it first waits until no chat is mid-reply. Either way it checks the new one
  answers and has picked up the running chats.
- **Look** — light theme by default; **More → Theme** has four light, four dark and three fun themes
  (remembered in this browser). On a phone the header shrinks to More and **+**, and an open chat fills the
  screen with a **‹ Back** button. The board orders projects and their chats by when the chats started, so
  busy projects don't swap places. Four tabs: Sessions, Projects, Automation (Queue, Agents, Scheduled jobs) and
  Insights (Usage, Repos, Activity). Row details are in the hover tooltip.
- **Search** — the board filter searches names and summaries; press **Enter** (or *Search all
  conversations*) to search inside every transcript, including older ones. Runs in a worker thread.
- **Queue** — jobs Claude works through in the background, one at a time, in auto mode, only while
  your 5-hour usage is under 60 % (on plans that have a 5-hour limit) and the week under 80 %, up to 10 a day. Claude Code itself
  hard-blocks (via `--disallowedTools`, in both Bash and PowerShell, anywhere in the command):
  sending/replying/forwarding/deleting email, sharing/deleting Drive files, Claude in Chrome, `ssh`,
  `scp`, `rsync`, `git push`, `wrangler deploy` / `d1 execute`, `deploy.sh`, and any `jobBlockedCommands` in
  `site.json`. Everything else relies on auto mode and your CLAUDE.md
  rules — e.g. `curl` or `docker exec` could still reach a live system — so ask jobs for drafts and
  reports. A job that needs a decision shows as **Needs you**.
- **Agents** — standing jobs with a goal that run on a timer through the queue (same limits and
  blocks): every N minutes (min 5) or hours, once at a set time, daily, weekdays or chosen days. New agents start
  switched **off**. Short intervals meet the queue's 10-jobs-a-day limit — the form says so. Queue jobs can also have a
  **Start at** time.
- **Weekly roundup** — Thursdays from 15:00 (or the next time the PC is on that week) one tool-less Sonnet call writes
  a short roundup of the week from Pit Wall's own records, and a second Claude run sends it to `roundupTo` from the person's own
  Gmail (their Claude account's Gmail connector). Pit Wall approves that run's tool calls itself: only one Gmail send,
  to exactly `roundupTo`, with exactly the roundup's subject and body — anything else is refused. A failed send is
  retried 3 times, 30 min apart, then the person is asked to send it (dialog: Send to … / Open in my email app).
  Needs a recipient: `roundupTo` in `data/local.json` or `site.json` (`roundupToName` names them on the page). On by
  default for team installs, off on the owner's PC; switch and **Write it now** are in Automation › Scheduled jobs.
  `data/local.json`: `roundupAutoSend: false` (review before sending).
- **Scheduled jobs** — your Windows scheduled tasks that run Claude or something in
  `Documents\GitHub`: schedule, last run and result (failures in red), next run, **Run now**
  (asks to confirm), **Switch on/off**.
- **Usage** — 5-hour and weekly gauges from Claude Code's own rate-limit readings; a plan with no
  5-hour limit (Ultra) reports only the week, so only the week shows. They arrive free
  with every Pit Wall session and organiser call; if the page is open and the reading is over 30
  minutes old, one tiny Haiku call refreshes it (max 40 a day).
- **Backups** — `data/pitwall.db` is copied to `data/backups/` daily; the last 7 are kept.

### Getting more out of your limits

- **Context meter** — every session shows how many tokens Claude re-reads on each turn (amber over
  300k, red over 600k). Most of your usage is this re-reading, not new work.
- **Fresh start** — asks a long session for a handoff, then continues in a new session seeded with
  just that summary; the old one is marked "continued in a fresh session". Reopening a big session
  that has been idle over an hour (its cache has expired) shows a warning offering this instead.
- **Usage tab** — heaviest sessions and projects by share of the week, burn rate ("the 5-hour limit
  runs out about 17:40", plans with that limit only), and tips (Fresh start candidates, screenshot-heavy sessions).
- **Project budgets** — set a weekly % on a project card; it's flagged when it goes over.
- **Model suggestions** — the New session and Queue forms suggest Sonnet for writing/reports/lookups
  and your usual model for code. Background jobs and agents default to **Sonnet**.
- **Off-peak jobs** — a queue option that waits until the 5-hour window is about to reset or is
  under 20% used. With no 5-hour limit it waits until the week is under 20% used or behind pace.

### Safety and tracking

- **Danger badges** — approvals that use ssh, deploy, git push, remote D1, send email or bulk delete
  are outlined in red with labels (patterns in `src/insights.mjs` → `DANGER_RULES`; add your own servers and APIs
  with `dangerRules` in `site.json`).
- **Repos tab** — every repo's branch, uncommitted/unpushed/behind counts and which open sessions are
  editing it; a **clash** warning when two open sessions edit the same code repo (the parent
  folder is excluded — every session writes vault notes there). Also **Waiting to go live**
  (checklist items marked built + memory notes that say "not deployed") and memory notes that may be
  out of date.
- **Activity tab** — per day: sessions, files changed, commits, deploys, and a reminder when code was
  committed without touching the vault.
- **Morning brief** — shown the first time you open Pit Wall each day (or the Brief button): what's
  waiting, follow-ups due, jobs finished overnight, failed scheduled jobs, what's waiting to go live,
  and the nightly review's suggestions and notes.
- **Nightly review** — Windows task `Pit Wall Nightly Review` (04:00, `node src/nightly-review.mjs`;
  `--dry-run` to preview). One tool-less Sonnet call reconciles the board with MEMORY.md, CLAUDE.md's
  Pending list and parked lines in the vault: corrects statuses, merges duplicates, adds parked work (at
  most 10 tasks a night) and **closes** tasks a source shows are retired, superseded or done another way
  (at most 15; closed tasks are never re-added). A project is **finished by rule** once every task is live
  and it has had no activity (chats or task changes) for 7 days. Anything you set by hand is never changed:
  those changes appear in the morning brief as **Board tidy-up** suggestions with Accept / Dismiss (a
  dismissed one is not suggested again). Report: `data/nightly-review/<date>.md`; backup first.
- **Follow-ups & snooze** — "Remind me…" on any chat (in an hour, tomorrow 09:00, next Monday, or a
  time); due follow-ups notify you and sit in Needs you until Done. **Snooze 1 h** hides a session
  from Needs you for an hour.
- **Scheduled checks** ("check X tomorrow morning") — Claude Code's CronCreate only lives inside one
  running chat: it is lost when the chat ends, when Pit Wall parks it to free a slot for a 7th chat, or on a
  restart. So a one-shot CronCreate due 15+ minutes ahead is caught by a hook (`src/hook-cron.mjs`) and
  saved as a queued job with a **Start at** time plus a follow-up that watches it; CronCreate itself is
  denied with a note telling Claude where the check went. At its time the queue runs it as a fresh
  session (no chat history, the usual hard blocks — so a check that needs `ssh` reports the step for
  you to run). It lands in Needs you as **ran** (open its chat to read it) or, if it hasn't started 15
  minutes after its time (queue paused, daily limit, usage, Pit Wall off) or failed, as **missed** —
  never silently gone. By hand: `node src/schedule.mjs add --at 2026-10-08T08:23 --title "…" --prompt-file f`,
  `list`, `cancel <job id>`. With the Queue off (team installs) it is a follow-up only.

### Speed

- **Command palette** — Ctrl+K to jump to any session, project, view, template or skill.
- **Templates** — save a New session setup (message, folder, model, effort, permissions) and reuse it.
- **Skills** — start any of your skills from the palette or type `/skill-name` in a message; agents
  can run a skill on a timetable (**daily, weekdays or chosen days at a time**, or every N hours).
  Workspace skills only work for folders inside `Documents\GitHub`.
- **Handoff** button — runs your `/handoff` skill (or, outside the workspace, asks for a
  paste-ready handoff prompt) for the other PC or a teammate's Claude.
- **Set up a new scheduled script** (Scheduled jobs tab) — opens a chat where Claude sets up,
  test-runs and registers a Windows task with you.
- **Dictation** — the microphone button uses Chrome's speech recognition. **Chrome sends the audio
  to Google** to transcribe it; don't dictate anything you wouldn't send to Google.
- **Read aloud** — under any reply (hover; on a phone, under the reply that ended a turn). Skips code
  blocks, tables, images and link addresses. **More → Read replies aloud** reads each reply that
  finishes a turn, hands-free (only in the chat you have open). **More → Voice** picks:
  - **Natural** (Emma, George, …) — Kokoro, an open speech model run on this PC by Pit Wall, so the
    text stays on the PC; phones using Pit Wall remotely get it too. Set it up once from the same
    menu (*Natural: set up*, PC only): it installs into `data/voice` (~720 MB with the model, its own
    npm install, not Pit Wall's). The model runs in a separate process that uses ~700 MB while loaded
    and exits after 10 minutes unused; the first sentence takes 1–3 s.
  - **This device** — the browser's own voices (Windows' on the PC): robotic, but instant and local.
  - **Google** — Chrome's Google voices: **send the text to Google**.

  Both settings are per device (kept in the browser), and Chrome only makes sound once you've
  clicked or typed on the page.

## Codex (a second engine)

**Off by default.** Until you turn it on, Pit Wall is Claude-only: no engine pickers, no Default engine setting,
no Codex gauge, and nothing Codex runs in the background. The one way in is **More › Codex (GPT)…**, a checklist:
**Install Codex** (`npm i -g @openai/codex@latest`; the same button becomes **Update Codex** when npm has a newer one,
checked every 6 hours), **Sign in** (opens `codex login` in a window on the PC), **Set up the sandbox** (opens an
elevated PowerShell running `codex sandbox setup --elevated --current-user`; Windows asks for admin approval),
**Check the sandbox** (a throwaway `codex app-server`, no model turns: it writes a file inside a scratch folder,
tries one outside it and tries the internet, under the sandbox a chat would get) and **Turn Codex on / off**.
Sign-in and sandbox setup work only at the PC. The switch is kept in Pit Wall's database; `data/local.json`
`"codexEnabled": true` turns it on for a PC before anyone touches it (`node src/setup.mjs --codex` writes that).
Turning Codex off moves new chats, jobs, agents and helpers back to Claude; existing Codex chats still open and
continue as Codex. When Codex is on, Pit Wall's update info also says whether a newer Codex is out.
(The panel is drawn by `public/app.js` with its wording in `public/engine-text.js` — no new file for the server's
STATIC list.)

Chats, queue jobs and agents can run on OpenAI Codex (ChatGPT Plus) instead of Claude Code. A Codex chat
runs as `node src/codex-bridge.mjs` under the same relay as a Claude chat, so it survives a Pit Wall restart.
The bridge drives `codex app-server` and speaks the subset of Claude Code's stream-json that Pit Wall uses:
streaming replies, approval cards, Stop, Queued messages and take-back. Its transcripts are in `data/codex/`.

- **Install and sign in:** More › Codex (GPT)… (or by hand: `npm i -g @openai/codex`, then `codex login`). Codex usage has its own gauges next to Claude's; background work is gated on
  the engine it runs on.
- **Default engine** (More › Settings) picks the engine for new chats, for jobs and agents left on
  "Default", and for Pit Wall's own helpers: titles, the organiser and the nightly review. The weekly
  roundup is always sent through Claude. You can still pick an engine per chat or job.
- **Usage when Codex is the default:** the header rings show GPT's 5-hour/week ("GPT 5-hour …"), with
  Claude's figures in the tooltip; the morning brief, the Queue status and wording follow the default
  engine too. Codex chats get a context badge, the live "↓ tokens" count and rows in Insights › Usage
  (tagged GPT, shares per engine so GPT never skews Claude's bars). GPT tokens are weighted like
  Claude's (token-equivalents), never shown as $. Codex chats from before this change show no usage.
- **Fork, rewind and /btw in Codex chats** (Codex app-server `thread/fork` / `thread/revert`): Fork and
  "Fork from here" start a new chat on a forked thread with the history up to that reply; Rewind drops a
  message and everything after it from the conversation but **does not undo file changes** (the dialog
  says so; Claude's rewind can); /btw asks on a throwaway read-only side thread that can't change files
  or reach the chat. A fork or resume of a queue job's chat stays locked down like the job. They need
  Pit Wall's turn map, so Codex chats started before this change keep them hidden.
- **Claude-only:** file undo on rewind, task Stop, subagent and workflow panels, Chrome, live model and
  permission switching, slash commands, CronCreate interception, cost in $, and the roundup send
  (Gmail connector). Codex has no equivalent for these; the page hides them for Codex chats.
- **Sandbox on Windows:** until the Windows sandbox is set up, Codex enforces nothing by itself. So Pit
  Wall runs Codex threads in the unelevated read-only sandbox, which needs no admin. Reading and running
  commands work, but every file write or network use needs an approval card (jobs decline them).
  **Allow on a card runs that command outside the sandbox, network included** (a `git push` would
  really push), so read it first. Sandboxed commands never reach the network. The elevated sandbox
  (`codex sandbox setup --elevated --current-user`, once, in an **admin** terminal) should give normal
  workspace-write chats, but that is untested here: check it before relying on it.
- **Debugging:** `PITWALL_CODEX_TRACE=<file>` makes each bridge append every raw line Codex sends to
  `<file>.<bridge pid>`. **The trace holds your account email and ids and whole conversations**: turn it
  off and delete the files when done, and scrub anything before sharing it.

## Use it from another PC (Cloudflare Tunnel + Access)

The server only ever listens on 127.0.0.1. `cloudflared` runs on this PC as a Windows service and forwards
`https://pitwall.example.com` to `http://127.0.0.1:4040` (use 127.0.0.1, not localhost — cloudflared
may try IPv6 `::1`, where nothing listens). A Cloudflare Access app on that hostname makes you log in first.

Pit Wall does not trust the tunnel on its own word: every proxied request must carry Access's signed token
(`Cf-Access-Jwt-Assertion`), checked against the team's published keys, issuer, this app's AUD tag, expiry and
an allowed email. Settings live in `data/remote.json` (git-ignored):

```json
{ "hosts": ["pitwall.example.com"], "team": "yourteam.cloudflareaccess.com",
  "aud": "<Application Audience (AUD) tag>", "emails": ["you@example.com"] }
```

Any field missing or empty means remote access is off. The file is read on every request, so edits need no
restart. Code: `src/remote.mjs`.

## The status hook (in your global Claude settings)

Setup adds six hooks to `~/.claude/settings.json`. Four (UserPromptSubmit, Notification, Stop, SessionEnd) run
`src/hook-status.mjs` in the background. It writes one small file per session to
`~/.claude/pitwall-status/` and nothing else — no output, always exits 0, 5-second limit. A fifth,
`UserPromptSubmit`, runs `src/hook-inbox.mjs` (see **Task status → the chat**). Setup saves your settings from before as
`~/.claude/settings.json.bak-pitwall-<date>`. To remove them, run `node src/setup.mjs --uninstall` (or delete
the entries, or use `/hooks` in Claude Code).

A sixth, synchronous `PreToolUse` hook (matcher `CronCreate`) runs `src/hook-cron.mjs` — see
**Scheduled checks** above. Recurring crons (`/loop`) and one-shots under 15 minutes pass through;
any error lets CronCreate run as before.

State lives in `data/pitwall.db` (git-ignored). Settings are in `src/config.mjs`.

## Test

`npm test`

## Licence

MIT — see [`LICENSE`](LICENSE).
