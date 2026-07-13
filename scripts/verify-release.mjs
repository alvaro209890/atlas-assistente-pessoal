import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'coverage', '.vite']);
const textExtensions = new Set([
  '', '.css', '.example', '.html', '.js', '.json', '.jsx', '.md', '.mjs',
  '.sql', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(absolute));
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) files.push(absolute);
  }
  return files;
}

const issues = [];
const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
for (const absolute of await listFiles(root)) {
  const file = relative(root, absolute).replaceAll('\\', '/');
  const content = await readFile(absolute, 'utf8');

  if (secretPatterns.some((pattern) => pattern.test(content))) {
    issues.push(`${file}: parece conter um segredo real`);
  }
  if (/(?:Álvaro|Alvaro)/u.test(content) && ![
    'LICENSE',
    'docs/atlas-personality.md',
    'scripts/verify-release.mjs',
  ].includes(file)) {
    issues.push(`${file}: contém um nome de usuário fixo`);
  }
  if (/\bNexo\b/.test(content) && ![
    'packages/integrations/src/trello.ts',
    'packages/integrations/tests/trello.test.ts',
  ].includes(file)) {
    issues.push(`${file}: contém a marca legada fora da compatibilidade permitida`);
  }
  if ((file.startsWith('apps/') || file.startsWith('packages/')) && /(?:\.hermes|vault_path|obsidian[_-](?:sync|watch|search))/i.test(content)) {
    issues.push(`${file}: contém dependência legada de Hermes/Obsidian`);
  }
  if (file !== '.env.example' && (
    file === '.env' || file.startsWith('.env.') || /(?:^|\/)(?:auth_info[^/]*|[^/]+\.creds\.json)$/i.test(file)
  )) {
    issues.push(`${file}: arquivo local sensível não pode ser publicado`);
  }
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (packageJson.name !== 'atlas-assistente-pessoal') {
  issues.push('package.json: nome raiz diferente de atlas-assistente-pessoal');
}

if (issues.length > 0) {
  console.error('Publicação bloqueada:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log('Verificação de publicação aprovada.');
}
