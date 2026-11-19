import { readFileSync } from 'node:fs';

const checks = [
  { group: 'unit', file: process.argv[2], minimum: 25, requiredFiles: 5 },
  { group: 'integration', file: process.argv[3], minimum: 13, requiredFiles: 3 },
];

if (process.argv.length !== 4) {
  throw new Error('Usage: node scripts/ci/check-test-reports.mjs <unit-report> <integration-report>');
}

for (const check of checks) {
  const report = JSON.parse(readFileSync(check.file, 'utf8'));
  const files = report.testResults;
  if (!Array.isArray(files) || files.length < check.requiredFiles) {
    throw new Error(`${check.group}: fewer test files than expected`);
  }
  const results = files.flatMap((file) => {
    if (!file.name.replaceAll('\\', '/').includes(`/tests/${check.group}/`)) {
      throw new Error(`${check.group}: unexpected test path ${file.name}`);
    }
    return file.assertionResults;
  });
  if (
    !report.success ||
    report.numTotalTests < check.minimum ||
    report.numTotalTests !== results.length ||
    report.numPassedTests !== results.length ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    results.some((result) => result.status !== 'passed')
  ) {
    throw new Error(
      `${check.group}: results are incomplete, skipped or below minimum (${JSON.stringify({
        total: report.numTotalTests,
        passed: report.numPassedTests,
        failed: report.numFailedTests,
        skipped: report.numPendingTests,
        todo: report.numTodoTests,
      })})`,
    );
  }
  console.log(`${check.group}: ${results.length} passed, 0 skipped across ${files.length} files`);
}
