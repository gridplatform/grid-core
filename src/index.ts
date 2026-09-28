import fs from 'fs-extra';
import { createApp } from './app';
import { config } from './config';

async function main() {
  await fs.ensureDir(config.dataDir);
  await fs.ensureDir(config.workDir);

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`grid-core listening on http://localhost:${config.port}`);
    console.log(`CLI root: ${config.cliRoot}`);
    console.log(`Work dir: ${config.workDir}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
