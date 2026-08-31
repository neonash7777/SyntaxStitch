import { defineConfig } from '@vscode/test-cli';

const test = version => ({ files: 'out/test/**/*.test.js', version });

export default defineConfig([test(process.env.VSCODE_TEST_VERSION ?? 'stable')]);
