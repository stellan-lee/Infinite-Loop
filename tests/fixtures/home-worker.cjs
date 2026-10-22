// Prints only the named paths/controls used by tests; never dumps the environment.
const fs = require('node:fs');
const path = require('node:path');
process.stdout.write(JSON.stringify({
  home: process.env.HOME ?? null,
  codexHome: process.env.CODEX_HOME ?? null,
  cwd: process.cwd(),
  args: process.argv.slice(2),
  homeExists: fs.existsSync(process.env.HOME || ''),
  codexHomeExists: fs.existsSync(process.env.CODEX_HOME || ''),
  homeIsDirectory: process.env.HOME ? fs.statSync(process.env.HOME).isDirectory() : false,
  proxy: process.env.HTTP_PROXY ?? null,
  secretPresent: process.env.INFLOOP_API_TOKEN !== undefined,
}));
