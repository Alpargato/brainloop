/**
 * Brainloop — construye el APK de principio a fin.
 *
 * Uso:  doble clic en CONSTRUIR-APK.bat   (o: node scripts/construir-apk.mjs)
 *       --simular   muestra los pasos sin ejecutar nada
 *
 * Se puede relanzar las veces que haga falta: lo que ya está hecho se salta.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const DRY = process.argv.includes('--simular');
const IS_WIN = process.platform === 'win32';
const TOTAL = 8;
const EAS = 'npx --yes eas-cli@latest';

const paint = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const cyan = paint('36');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const dim = paint('90');
const bold = paint('1');

let n = 0;
const step = (title) => console.log(`\n${cyan(`[${++n}/${TOTAL}]`)} ${bold(title)}`);
const ok = (msg) => console.log(green(`  ✔ ${msg}`));
const info = (msg) => console.log(`  ${msg}`);
const warn = (msg) => console.log(yellow(`  ! ${msg}`));

function fail(msg, hint) {
  console.log(red(`\n  ✖ ${msg}`));
  if (hint) console.log(yellow(`    ${hint}`));
  console.log(dim('\n  Cuando lo arregles, vuelve a abrir CONSTRUIR-APK.bat: retoma donde se quedó.'));
  process.exit(1);
}

/** Ejecuta un comando en la ventana. capture=true devuelve stdout en vez de mostrarlo. */
function run(cmd, { capture = false } = {}) {
  console.log(dim(`  > ${cmd}`));
  if (DRY) return { code: 0, out: '' };
  const r = spawnSync(cmd, {
    shell: true,
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
  });
  if (r.error) return { code: 1, out: '' };
  return { code: r.status ?? 1, out: r.stdout ?? '' };
}

async function ask(question) {
  if (DRY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(yellow(`  ? ${question} (S/n) `))).trim().toLowerCase();
  rl.close();
  return ['', 's', 'si', 'sí', 'y', 'yes'].includes(a);
}

const has = (cmd) => run(`${cmd} --version`, { capture: true }).code === 0;
const readAppJson = () => JSON.parse(readFileSync('app.json', 'utf8'));

console.log(cyan(bold('\n  BRAINLOOP · construir APK')));
console.log(dim(`  Carpeta: ${ROOT}${DRY ? '   (modo simulación)' : ''}`));
console.log(dim('  Tardará unos 15-25 min: casi todo es la compilación en los servidores de Expo.'));

// 1 ─ Herramientas ─────────────────────────────────────────────────────────────
step('Comprobando Node.js y Git');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) fail(`Node.js ${process.versions.node} es demasiado antiguo.`, 'Instala Node.js 20 o 22 LTS desde https://nodejs.org');
ok(`Node.js ${process.versions.node}`);
if (nodeMajor > 22) warn('Probado con Node 20/22 LTS. Si algo falla, instala la versión LTS.');
if (!has('git')) {
  if (IS_WIN && has('winget') && (await ask('No tienes Git. ¿Lo instalo ahora con winget?'))) {
    run('winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements');
    fail('Git instalado.', 'Cierra esta ventana y vuelve a abrir CONSTRUIR-APK.bat para que Windows lo detecte.');
  }
  fail('Git no está instalado.', 'Descárgalo de https://git-scm.com/download/win y vuelve a ejecutar el script.');
}
ok('Git disponible');

// 2 ─ Dependencias ─────────────────────────────────────────────────────────────
step('Instalando dependencias (npm install)');
if (run('npm install --no-audit --no-fund').code !== 0)
  fail('npm install ha fallado.', 'Revisa la conexión a internet y vuelve a intentarlo.');
ok('Dependencias instaladas y package-lock.json actualizado');

// 3 ─ Versiones ────────────────────────────────────────────────────────────────
step('Alineando versiones con Expo SDK 52');
if (run('npx --yes expo install --fix').code === 0) ok('Versiones correctas');
else warn('expo install --fix no pudo terminar; se continúa (no suele ser grave).');

// 4 ─ Comprobación del código ──────────────────────────────────────────────────
step('Comprobando el código');
if (run('npm run typecheck').code !== 0)
  fail('El código tiene errores de TypeScript.', 'Los errores aparecen arriba.');
ok('TypeScript sin errores');
if (run('npx --yes expo-doctor@latest').code === 0) ok('expo-doctor: todo correcto');
else warn('expo-doctor ha mostrado avisos (arriba). Normalmente no impiden compilar; se continúa.');

// 5 ─ Git ──────────────────────────────────────────────────────────────────────
step('Guardando la versión en Git');
if (!existsSync('.git')) run('git init');
// Identidad neutra solo para este repositorio: los commits no incluyen datos personales.
run('git config user.name "Brainloop"');
run('git config user.email "build@brainloop.invalid"');
const commitIfChanges = (message) => {
  run('git add -A');
  if (run('git diff --cached --quiet').code === 0) return false;
  if (run(`git commit -q -m "${message}"`).code !== 0) fail('No se pudo hacer el commit.');
  return true;
};
const version = readAppJson().expo.version;
ok(commitIfChanges(`Brainloop ${version}`) ? `Commit "Brainloop ${version}" creado` : 'Sin cambios pendientes');
run('git gc --prune=now --quiet');
ok('Restos antiguos de Git eliminados');

// 6 ─ Cuenta Expo ──────────────────────────────────────────────────────────────
step('Cuenta de Expo');
const who = run(`${EAS} whoami`, { capture: true });
if (who.code === 0 && who.out.trim()) {
  ok(`Sesión iniciada como ${who.out.trim().split(/\r?\n/)[0]}`);
} else {
  info('Introduce el email/usuario y la contraseña de tu cuenta de expo.dev (crea una gratis si no tienes).');
  if (run(`${EAS} login`).code !== 0) fail('No se pudo iniciar sesión en Expo.');
  ok('Sesión iniciada');
}

// 7 ─ Proyecto EAS ─────────────────────────────────────────────────────────────
step('Proyecto "brainloop" en expo.dev');
if (readAppJson().expo.extra?.eas?.projectId) {
  ok('Proyecto ya vinculado');
} else {
  info(`Si pregunta ${bold('"Would you like to create a project…?"')} responde ${bold('Y')}.`);
  if (run(`${EAS} init`).code !== 0 || (!DRY && !readAppJson().expo.extra?.eas?.projectId))
    fail('No se pudo crear/vincular el proyecto en Expo.');
  commitIfChanges('Vincular proyecto EAS');
  ok('Proyecto creado y vinculado');
}

// 8 ─ Build ────────────────────────────────────────────────────────────────────
step('Compilando el APK en los servidores de Expo');
info(`La primera vez preguntará ${bold('"Generate a new Android Keystore?"')} → responde ${bold('Y')}.`);
info('No cierres esta ventana: esperará a que termine la compilación y descargará el APK.');
if (run(`${EAS} build -p android --profile preview`).code !== 0)
  fail('La compilación ha fallado.', 'El detalle está en el enlace "Build details" de arriba.');
ok('APK compilado');

// Descarga automática del APK
let apkPath = null;
if (!DRY) {
  try {
    const list = run(`${EAS} build:list --platform android --status finished --limit 1 --json --non-interactive`, {
      capture: true,
    });
    const url = JSON.parse(list.out.slice(list.out.indexOf('[')))[0]?.artifacts?.buildUrl;
    if (url) {
      mkdirSync('APK', { recursive: true });
      apkPath = join(ROOT, 'APK', `Brainloop-${version}.apk`);
      info('Descargando el APK…');
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      writeFileSync(apkPath, Buffer.from(await res.arrayBuffer()));
    }
  } catch {
    apkPath = null;
  }
}

console.log(green(bold('\n  ✔ ¡LISTO!')));
if (apkPath) {
  info(`APK guardado en: ${bold(apkPath)}`);
  if (IS_WIN) run(`explorer "${join(ROOT, 'APK')}"`);
} else if (!DRY) {
  info('Descarga el APK desde el enlace o el QR que aparece arriba (o en expo.dev → tu proyecto → Builds).');
}
info('Pásalo al móvil, ábrelo y permite "instalar apps de origen desconocido".');
console.log(yellow('\n  IMPORTANTE: guarda una copia de tu keystore (sin él no podrás actualizar la app):'));
info(`  ${EAS} credentials -p android   →  Keystore  →  Download`);
