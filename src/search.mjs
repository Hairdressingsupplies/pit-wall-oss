// Runs one transcript search at a time in a worker thread; a new search cancels the previous one.
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'search-worker.mjs');

export class Search {
  constructor({ projectsDir, projectsDirs = [projectsDir], isExcludedProjectDir, timeoutMs = 60_000 }) {
    Object.assign(this, { projectsDir, projectsDirs, isExcludedProjectDir, timeoutMs });
    this.current = null;
  }

  run(q) {
    q = String(q ?? '').trim();
    if (q.length < 3) return Promise.reject(Object.assign(new Error('Search for at least 3 characters.'), { status: 400 }));
    if (this.current) { this.current.cancelled = true; this.current.worker.terminate(); }
    const excludedDirs = [...new Set(this.projectsDirs.flatMap(root => {
      try { return fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && this.isExcludedProjectDir(d.name)).map(d => d.name); } catch { return []; }
    }))];
    const worker = new Worker(WORKER, { workerData: { q: q.slice(0, 200), projectsDirs: this.projectsDirs, excludedDirs } });
    const job = { worker, cancelled: false };
    this.current = job;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(Object.assign(new Error('Search took too long — try more specific words.'), { status: 504 })); }, this.timeoutMs);
      worker.once('message', m => { clearTimeout(timer); if (this.current === job) this.current = null; resolve(m); });
      worker.once('error', e => { clearTimeout(timer); reject(e); });
      worker.once('exit', () => {
        clearTimeout(timer);
        if (job.cancelled) reject(Object.assign(new Error('Replaced by a newer search.'), { status: 409 }));
      });
    });
  }
}
