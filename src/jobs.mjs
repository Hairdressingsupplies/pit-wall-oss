// Scheduled jobs panel: reads Windows Task Scheduler (via PowerShell's ScheduledTasks module, which
// returns clean JSON — schtasks' CSV breaks on commands containing quotes) and lists only your own
// automation: tasks whose action runs Claude Code or something in Documents\GitHub.
// Run / enable / disable only ever act on a task taken from that list; names travel in environment
// variables, never inside the command text.
import { execFile } from 'node:child_process';

const LIST = `
$ErrorActionPreference = 'Stop'
$out = foreach ($t in Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' }) {
  $i = $t | Get-ScheduledTaskInfo
  [pscustomobject]@{
    name = $t.TaskName; path = $t.TaskPath; state = [string]$t.State
    actions = @($t.Actions | ForEach-Object { (([string]$_.Execute) + ' ' + ([string]$_.Arguments)).Trim() })
    workingDir = @($t.Actions | ForEach-Object { [string]$_.WorkingDirectory })
    lastRun = if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('o') } else { $null }
    lastResult = $i.LastTaskResult
    nextRun = if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null }
    triggers = @($t.Triggers | ForEach-Object {
      [pscustomobject]@{
        kind = $_.CimClass.CimClassName -replace '^MSFT_Task|Trigger$', ''
        days = [int]$_.DaysOfWeek
        every = [int]$_.DaysInterval
        at = if ($_.StartBoundary) { ([datetime]$_.StartBoundary).ToString('HH:mm') } else { '' }
      }
    })
  }
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`;

const ACT = `
$ErrorActionPreference = 'Stop'
$t = Get-ScheduledTask -TaskName $env:PW_TASK -TaskPath $env:PW_PATH
switch ($env:PW_ACTION) {
  'run' { $t | Start-ScheduledTask }
  'enable' { $t | Enable-ScheduledTask | Out-Null }
  'disable' { $t | Disable-ScheduledTask | Out-Null }
}
`;

function ps(script, env = {}, timeout = 45_000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n')[0])) : resolve(stdout)));
  });
}

const MINE = /documents\\github|laragon\\www|claude\.exe/i;

/** Win32 task results worth explaining in plain words. */
const RESULTS = {
  0: 'OK', 1: 'Failed (exit code 1)', 2: 'Failed (exit code 2)',
  267008: 'Ready (never run)', 267009: 'Running now', 267011: 'Never run', 267014: 'Stopped by you',
  2147750687: 'Already running', 2147942402: 'File not found', 2147942405: 'Access denied',
};

export function describeResult(code) {
  if (code == null) return '';
  const n = Number(code) >>> 0;
  return RESULTS[n] ?? `Failed (code 0x${n.toString(16)})`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Weekly on Thu at 16:30", "Daily at 08:00", "At log on". */
export function describeTrigger(t) {
  const at = t.at ? ` at ${t.at}` : '';
  if (t.kind === 'Weekly') {
    const days = DAY_NAMES.filter((_, i) => t.days & (1 << i)).join(', ');
    return `Weekly${days ? ' on ' + days : ''}${at}`;
  }
  if (t.kind === 'Daily') return `${t.every > 1 ? `Every ${t.every} days` : 'Daily'}${at}`;
  if (t.kind === 'Logon') return 'At log on';
  if (t.kind === 'Boot') return 'At start-up';
  return `${t.kind}${at}`;
}

export function jobsFromTasks(tasks) {
  return tasks
    .filter(t => t.actions.some(a => MINE.test(a)) || t.workingDir.some(w => MINE.test(w)))
    .map(t => {
      const code = t.lastResult == null ? null : Number(t.lastResult) >>> 0;
      return {
        id: `${t.path}${t.name}`,
        name: t.name,
        path: t.path,
        enabled: t.state !== 'Disabled',
        running: t.state === 'Running',
        lastRun: t.lastRun,
        lastResult: describeResult(code),
        ok: code === 0 || code === 267009,
        neverRun: !t.lastRun,
        nextRun: t.enabled === false ? null : t.nextRun,
        schedule: t.triggers.map(describeTrigger).join('; '),
        action: t.actions.join(' && ').slice(0, 240),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class Jobs {
  constructor({ psFn = ps } = {}) {
    this.psFn = psFn;
    this.cache = null;
  }

  async list({ fresh = false } = {}) {
    if (!fresh && this.cache && Date.now() - this.cache.at < 30_000) return this.cache.jobs;
    const raw = (await this.psFn(LIST)).trim();
    const jobs = jobsFromTasks(raw ? JSON.parse(raw) : []);
    this.cache = { at: Date.now(), jobs };
    return jobs;
  }

  /** action: 'run' | 'enable' | 'disable' — only for a task that is in your list right now. */
  async act(id, action) {
    if (!['run', 'enable', 'disable'].includes(action)) throw Object.assign(new Error('Unknown action.'), { status: 400 });
    const job = (await this.list({ fresh: true })).find(j => j.id === id);
    if (!job) throw Object.assign(new Error('That task is not one of your scheduled jobs.'), { status: 404 });
    await this.psFn(ACT, { PW_TASK: job.name, PW_PATH: job.path, PW_ACTION: action });
    this.cache = null;
    return true;
  }
}
