#!/usr/bin/env node
/**
 * Cross-platform `npm run dev`: starts the API and the web app together.
 *
 * A shell `&` (the previous script) is a sequential separator in cmd.exe, so on
 * Windows the web server never started. This runner spawns both workspaces,
 * forwards their output, and stops both when either exits or the user presses
 * Ctrl+C. Shutdown waits for the kill to finish, otherwise the API's grandchild
 * outlives the runner and keeps holding port 4000.
 *
 * Set WEB_PORT to serve the web app elsewhere; that origin must also be in
 * CORS_ORIGINS in apps/api/.env or the API rejects its requests.
 */
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const webPort = process.env.WEB_PORT ?? '5173';
const apiPort = process.env.PORT ?? '4000';

const children = new Set();
let shuttingDown = false;

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    if (isWindows && child.pid) {
      // npm.cmd runs through cmd.exe; only taskkill /T reaches tsx and vite.
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([...children].map(stop));
  process.exit(code);
}

function run(label, args) {
  const child = spawn(isWindows ? 'npm.cmd' : 'npm', args, {
    stdio: 'inherit',
    shell: isWindows,
    env: process.env,
  });
  children.add(child);
  child.on('exit', (code) => {
    children.delete(child);
    if (!shuttingDown) {
      console.log(`\n[dev] ${label} exited (code ${code ?? 'unknown'}); stopping the rest.`);
      void shutdown(code ?? 1);
    }
  });
  child.on('error', (error) => {
    console.error(`[dev] could not start ${label}: ${error.message}`);
    void shutdown(1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => void shutdown(0));
}

if (webPort !== '5173') {
  console.log(
    `[dev] WEB_PORT=${webPort}: add http://localhost:${webPort} to CORS_ORIGINS in apps/api/.env.`,
  );
}
console.log(`[dev] starting API on http://localhost:${apiPort} and the web app...`);

run('api', ['run', 'dev', '--workspace=apps/api']);
run('web', ['run', 'dev', '--workspace=apps/web']);
