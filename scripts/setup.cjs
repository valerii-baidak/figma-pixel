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

function detectOpenCvJsRuntime() {
  const opencvJsPath = path.join(skillDir, 'node_modules', '@techstark', 'opencv-js');
  return {
    ok: fs.existsSync(opencvJsPath),
    engine: 'opencv-js',
    note: fs.existsSync(opencvJsPath)
      ? 'OpenCV.js runtime is available.'
      : 'OpenCV.js not detected yet. Run setup to enable OpenCV-based diff analysis.'
  };
}

fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

const command = 'npm install';
const result = spawnSync('npm', ['install'], {
  cwd: skillDir,
  stdio: 'pipe',
  encoding: 'utf8',
  shell: false,
});

const nodeRegionAnalysis = detectOpenCvJsRuntime();

const report = {
  ok: result.status === 0,
  command,
  cwd: skillDir,
  exitCode: result.status,
  stdout: result.stdout,
  stderr: result.stderr,
  dependencies: Object.keys(packageJson.dependencies),
  nodeRegionAnalysis,
};

fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

if (result.status !== 0) {
  console.error('figma-pixel setup failed');
  console.error(`command: ${command}`);
  console.error(`report: ${reportPath}`);
  console.error(result.stderr || result.stdout || 'Unknown setup error');
  process.exit(result.status || 1);
}

console.log(JSON.stringify({
  ok: true,
  report: reportPath,
  installed: Object.keys(packageJson.dependencies),
  nodeRegionAnalysis,
}, null, 2));
process.exit(0);
