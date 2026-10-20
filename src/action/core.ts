import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EOL } from 'node:os';
import { pathToFileURL } from 'node:url';

/** The parts of `@actions/core` the Action uses, reading and writing through injectable `env`/`stdout`. */
export interface ActionCore {
  getInput(name: string, options?: { required?: boolean }): string;
  getBooleanInput(name: string, fallback: boolean): boolean;
  setOutput(name: string, value: string): void;
  exportVariable(name: string, value: string): void;
  setSecret(value: string): void;
  saveState(name: string, value: string): void;
  getState(name: string): string;
  info(message: string): void;
  notice(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

const escapeData = (value: string) => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** Where main tells post which file to delete. */
export const CREDENTIALS_PATH_STATE = 'credentials_path';

export const createCore = ({
  env = process.env,
  stdout = (text: string) => void process.stdout.write(text),
}: { env?: NodeJS.ProcessEnv; stdout?: (text: string) => void } = {}): ActionCore => {
  const fileCommand = (variable: 'GITHUB_OUTPUT' | 'GITHUB_ENV' | 'GITHUB_STATE', name: string, value: string) => {
    const file = env[variable];
    if (!file) throw new Error(`${variable} is not set; this must run inside GitHub Actions.`);
    const delimiter = `ghadelimiter_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`, 'utf8');
  };

  const getInput = (name: string, { required = false }: { required?: boolean } = {}) => {
    const value = (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
    if (required && !value) throw new Error(`Input required and not supplied: ${name}`);
    return value;
  };

  return {
    getInput,
    getBooleanInput(name, fallback) {
      const value = getInput(name);
      if (!value) return fallback;
      if (/^true$/i.test(value)) return true;
      if (/^false$/i.test(value)) return false;
      throw new Error(`Input ${name} must be true or false, not "${value}".`);
    },
    setOutput: (name, value) => fileCommand('GITHUB_OUTPUT', name, value),
    exportVariable(name, value) {
      env[name] = value;
      fileCommand('GITHUB_ENV', name, value);
    },
    setSecret: (value) => stdout(`::add-mask::${escapeData(value)}${EOL}`),
    saveState: (name, value) => fileCommand('GITHUB_STATE', name, value),
    getState: (name) => env[`STATE_${name}`] ?? '',
    info: (message) => stdout(`${message}${EOL}`),
    notice: (message) => stdout(`::notice::${escapeData(message)}${EOL}`),
    warning: (message) => stdout(`::warning::${escapeData(message)}${EOL}`),
    error: (message) => stdout(`::error::${escapeData(message)}${EOL}`),
  };
};

/** Whether this module is the script Node was started with, so the bundled entry points run on load. */
export const isEntryPoint = (moduleUrl: string, argv1 = process.argv[1]): boolean =>
  argv1 !== undefined && pathToFileURL(argv1).href === moduleUrl;
