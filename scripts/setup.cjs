#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const skillDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(skillDir, 'package.json');
const reportPath = path.join(skillDir, 'setup-report.json');

const packageJson = {
  name: 'figma-pixel-skill-runtime',
  private: true,
  type: 'commonjs',
  dependencies: {
    backstopjs: '^6.3.25',
    pixelmatch: '^7.1.0',
    pngjs: '^7.0.0',
    playwright: '^1.59.1'
  }
};

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

const steps = [];

function runStep(command, args) {
  const result = spawnSync(command, args, {
    cwd: skillDir,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: false,
  });

  steps.push({
    command: [command, ...args].join(' '),
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });

  return result;
}

const npmInstall = runStep('npm', ['install']);
if (npmInstall.status !== 0) {
  const report = {
    ok: false,
    cwd: skillDir,
    dependencies: Object.keys(packageJson.dependencies),
    steps,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.error('figma-pixel setup failed');
  console.error('command: npm install');
  console.error(`report: ${reportPath}`);
  console.error(npmInstall.stderr || npmInstall.stdout || 'Unknown setup error');
  process.exit(npmInstall.status || 1);
}

const playwrightInstall = runStep('npx', ['playwright', 'install', 'chromium']);

const report = {
  ok: playwrightInstall.status === 0,
  cwd: skillDir,
  dependencies: Object.keys(packageJson.dependencies),
  browsers: ['chromium'],
  steps,
};

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

if (playwrightInstall.status !== 0) {
  console.error('figma-pixel setup failed');
  console.error('command: npx playwright install chromium');
  console.error(`report: ${reportPath}`);
  console.error(playwrightInstall.stderr || playwrightInstall.stdout || 'Unknown browser setup error');
  process.exit(playwrightInstall.status || 1);
}

console.log(JSON.stringify({
  ok: true,
  report: reportPath,
  installed: Object.keys(packageJson.dependencies),
  browsers: ['chromium']
}, null, 2));
process.exit(0);
