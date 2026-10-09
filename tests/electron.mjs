import electronPath from 'electron';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

export const executablePath = path.resolve(process.env.READER_PACKAGED_EXE || electronPath);
export function launch(userData) {
  const args = process.env.READER_PACKAGED_EXE ? [] : ['.'];
  // Headless Linux CI runs as root. Production sandbox settings stay enabled.
  if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox');
  return electron.launch({ executablePath, args, cwd: process.cwd(), env: { ...process.env, READER_TEST_USER_DATA: userData } });
}
