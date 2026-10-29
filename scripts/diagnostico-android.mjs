/**
 * Brainloop — diagnóstico por USB.
 * Arranca la app en el móvil conectado, espera unos segundos y guarda en
 * diagnostico/ solo lo que tiene que ver con Brainloop: errores, crash y qué hay en pantalla.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const PKG = 'app.brainloop.ai';
const OUT = join(ROOT, 'diagnostico');
const IS_WIN = process.platform === 'win32';
const paint = (c) => (s) => `\x1b[${c}m${s}\x1b[0m`;
const [cyan, green, yellow, red, dim, bold] = ['36', '32', '33', '31', '90', '1'].map(paint);
const ok = (m) => console.log(green(`  ✔ ${m}`));
const info = (m) => console.log(`  ${m}`);
const fail = (m, hint) => {
  console.log(red(`\n  ✖ ${m}`));
  if (hint) console.log(yellow(`    ${hint}`));
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pause(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(yellow(`  ${q} `));
  rl.close();
}

let ADB = null;
const adb = (args, opts = {}) => {
  const r = spawnSync(ADB, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return { code: r.status ?? 1, out: (r.stdout || '') + (opts.withErr ? r.stderr || '' : '') };
};

console.log(cyan(bold('\n  BRAINLOOP · diagnóstico por USB\n')));

// 1. Encontrar adb (o descargarlo de Google)
const candidates = [
  'adb',
  join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', IS_WIN ? 'adb.exe' : 'adb'),
  join(ROOT, 'tools', 'platform-tools', IS_WIN ? 'adb.exe' : 'adb'),
];
for (const c of candidates) {
  if (spawnSync(c, ['version'], { encoding: 'utf8' }).status === 0) {
    ADB = c;
    break;
  }
}
if (!ADB) {
  info('No encuentro adb. Descargando las herramientas oficiales de Google (≈7 MB)…');
  const os = IS_WIN ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  mkdirSync(join(ROOT, 'tools'), { recursive: true });
  const zip = join(ROOT, 'tools', 'platform-tools.zip');
  try {
    const res = await fetch(`https://dl.google.com/android/repository/platform-tools-latest-${os}.zip`);
    if (!res.ok) throw new Error(String(res.status));
    writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    fail('No se pudo descargar adb.', 'Revisa tu conexión a internet y vuelve a intentarlo.');
  }
  let x = spawnSync('tar', ['-xf', zip, '-C', join(ROOT, 'tools')], { stdio: 'inherit' });
  if (x.status !== 0 && IS_WIN)
    x = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${zip}' '${join(ROOT, 'tools')}'`], {
      stdio: 'inherit',
    });
  ADB = candidates[2];
  if (spawnSync(ADB, ['version'], { encoding: 'utf8' }).status !== 0) fail('No se pudo preparar adb.');
}
ok('adb listo');

// 2. Móvil conectado y autorizado
for (let i = 0; ; i++) {
  const lines = adb(['devices']).out.split(/\r?\n/).slice(1).filter((l) => l.trim());
  if (lines.some((l) => /\tdevice$/.test(l))) break;
  if (i >= 4) fail('El móvil no aparece como autorizado.', 'Revisa el cable USB y que la depuración USB esté activada.');
  if (lines.some((l) => /unauthorized/.test(l))) info('En el móvil aparece "¿Permitir depuración USB?": marca "Permitir siempre" y acepta.');
  else info('No veo ningún móvil. Conéctalo por USB (modo transferencia de archivos) con la depuración USB activada.');
  await pause('Pulsa Enter cuando esté listo…');
}
const model = adb(['shell', 'getprop', 'ro.product.model']).out.trim();
const android = adb(['shell', 'getprop', 'ro.build.version.release']).out.trim();
const sdk = adb(['shell', 'getprop', 'ro.build.version.sdk']).out.trim();
ok(`Móvil conectado: ${model} · Android ${android} (API ${sdk})`);

if (!adb(['shell', 'pm', 'list', 'packages', PKG]).out.includes(PKG))
  fail('Brainloop no está instalada en este móvil.', 'Instala el APK y vuelve a ejecutar este diagnóstico.');
const ver = (adb(['shell', 'dumpsys', 'package', PKG]).out.match(/versionName=(\S+)/) || [])[1] || '?';
ok(`Brainloop instalada (versión ${ver})`);

// 3. Arranque limpio y captura
adb(['logcat', '-c']);
adb(['logcat', '-b', 'crash', '-c']);
adb(['shell', 'am', 'force-stop', PKG]);
info('Abriendo Brainloop en el móvil… mira la pantalla del teléfono.');
adb(['shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1']);
for (let s = 15; s > 0; s--) {
  process.stdout.write(dim(`\r  Esperando ${String(s).padStart(2)} s… `));
  await sleep(1000);
}
process.stdout.write('\r' + ' '.repeat(30) + '\r');

const pidNow = adb(['shell', 'pidof', PKG]).out.trim();
const focus = (adb(['shell', 'dumpsys', 'window']).out.match(/mCurrentFocus=.*$/m) || [''])[0];
const full = adb(['logcat', '-d', '-v', 'threadtime']).out;
const crash = adb(['logcat', '-d', '-b', 'crash', '-v', 'threadtime']).out;

// PIDs que tuvo la app (si se reinició, hay varios)
const pids = new Set(pidNow ? pidNow.split(/\s+/) : []);
for (const m of full.matchAll(new RegExp(`Start proc (\\d+):${PKG.replace(/\./g, '\\.')}`, 'g'))) pids.add(m[1]);
const mine = full
  .split(/\r?\n/)
  .filter((l) => {
    const pid = l.trim().split(/\s+/)[2];
    return pids.has(pid) || l.includes(PKG) || /\bAndroidRuntime\b/.test(l);
  })
  .join('\n');

// Qué hay en pantalla (árbol de accesibilidad: funciona aunque las capturas estén bloqueadas)
let screenTexts = '(no disponible)';
if (adb(['shell', 'uiautomator', 'dump', '/sdcard/brainloop-ui.xml'], { withErr: true }).code === 0) {
  const xml = adb(['exec-out', 'cat', '/sdcard/brainloop-ui.xml']).out;
  adb(['shell', 'rm', '/sdcard/brainloop-ui.xml']);
  const texts = [...xml.matchAll(/text="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
  const pkgs = [...new Set([...xml.matchAll(/package="([^"]+)"/g)].map((m) => m[1]))];
  screenTexts = `paquetes: ${pkgs.join(', ')}\ntextos: ${texts.join(' | ') || '(ninguno)'}`;
}

mkdirSync(OUT, { recursive: true });
const report = [
  `# Diagnóstico Brainloop — ${new Date().toISOString()}`,
  `Móvil: ${model} · Android ${android} (API ${sdk}) · Brainloop ${ver}`,
  `Proceso vivo tras 15 s: ${pidNow ? 'sí (pid ' + pidNow + ')' : 'NO (la app se cerró)'}`,
  `Ventana en primer plano: ${focus}`,
  '',
  '## Pantalla (árbol de accesibilidad)',
  screenTexts,
  '',
  '## Buffer de crash',
  crash.trim() || '(vacío)',
  '',
  '## Log de Brainloop',
  mine.trim() || '(vacío)',
].join('\n');
writeFileSync(join(OUT, 'logcat-brainloop.txt'), report);

const errs = mine.split('\n').filter((l) => / [EF] (ReactNativeJS|AndroidRuntime|ReactNative|unknown)/.test(l));
console.log('');
ok(`Informe guardado en diagnostico\\logcat-brainloop.txt`);
info(`App viva tras 15 s: ${pidNow ? green('sí') : red('NO, se cerró')}`);
info(`En pantalla: ${screenTexts.split('\n')[1] || screenTexts}`);
if (errs.length) {
  console.log(red(`\n  Errores detectados (${errs.length}):`));
  errs.slice(0, 8).forEach((l) => console.log(red('   ' + l.slice(0, 220))));
}
