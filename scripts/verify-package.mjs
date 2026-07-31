import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageDirectory = process.argv[2] ?? join('release', 'win-unpacked');
const unpacked = resolve(root, packageDirectory);
const resources = join(unpacked, 'resources');
const asar = join(resources, 'app.asar');
const executable = join(unpacked, '喵喵翻译.exe');

for (const path of [asar, executable]) {
  if (!existsSync(path)) throw new Error(`Missing packaged file: ${path}`);
}

const asarCli = resolve(root, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
const entries = execFileSync(process.execPath, [asarCli, 'list', asar], {
  encoding: 'utf8',
  env: { ...process.env, NODE_PATH: process.env.NODE_PATH ?? '' }
})
  .split(/\r?\n/)
  .map(entry => `/${entry.replaceAll('\\', '/').replace(/^\/+/, '')}`)
  .filter(entry => entry !== '/');

for (const expected of ['/package.json', '/dist-electron/main/index.js', '/dist-electron/preload/index.js', '/dist/index.html']) {
  if (!entries.includes(expected)) throw new Error(`Missing ASAR entry: ${expected}`);
}
if (entries.some(entry => entry.startsWith('/node_modules/'))) {
  throw new Error('Packaged ASAR unexpectedly contains runtime node_modules');
}

const unpackedApp = `${asar}.unpacked`;
if (existsSync(unpackedApp)) {
  const pending = [unpackedApp];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        if (!existsSync(resolve(directory, link))) throw new Error(`Broken packaged link: ${relative(root, path)} -> ${link}`);
      } else if (stat.isDirectory()) pending.push(path);
      else if (/linux|\.so(?:\.|$)|skia\.linux/i.test(path)) throw new Error(`Linux artifact in Windows package: ${relative(root, path)}`);
    }
  }
}

if (process.platform === 'win32') {
  const probe = "require('./resources/app.asar/dist-electron/main/index.js'); setTimeout(() => process.exit(0), 250)";
  execFileSync(executable, ['-e', probe], {
    cwd: unpacked,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'pipe',
    timeout: 15000
  });
} else {
  console.log('Skipping executable load probe: it requires a Windows host.');
}

console.log(`Package integrity verified: ${executable}`);
