import { defineConfig } from '@vscode/test-cli';

const test = version => ({ files: 'out/test/**/*.test.js', version });

export default defineConfig([
	test('1.127.0'),
	test('stable'),
]);
