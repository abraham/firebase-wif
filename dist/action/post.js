// src/action/post.ts
import { rm } from "node:fs/promises";

// src/action/core.ts
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EOL } from "node:os";
import { pathToFileURL } from "node:url";
var escapeData = (value) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
var CREDENTIALS_PATH_STATE = "credentials_path";
var createCore = ({
  env = process.env,
  stdout = (text) => void process.stdout.write(text)
} = {}) => {
  const fileCommand = (variable, name, value) => {
    const file = env[variable];
    if (!file) throw new Error(`${variable} is not set; this must run inside GitHub Actions.`);
    const delimiter = `ghadelimiter_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`, "utf8");
  };
  const getInput = (name, { required = false } = {}) => {
    const value = (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
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
    setOutput: (name, value) => fileCommand("GITHUB_OUTPUT", name, value),
    exportVariable(name, value) {
      env[name] = value;
      fileCommand("GITHUB_ENV", name, value);
    },
    setSecret: (value) => stdout(`::add-mask::${escapeData(value)}${EOL}`),
    saveState: (name, value) => fileCommand("GITHUB_STATE", name, value),
    getState: (name) => env[`STATE_${name}`] ?? "",
    info: (message) => stdout(`${message}${EOL}`),
    notice: (message) => stdout(`::notice::${escapeData(message)}${EOL}`),
    warning: (message) => stdout(`::warning::${escapeData(message)}${EOL}`),
    error: (message) => stdout(`::error::${escapeData(message)}${EOL}`)
  };
};
var isEntryPoint = (moduleUrl, argv1 = process.argv[1]) => argv1 !== void 0 && pathToFileURL(argv1).href === moduleUrl;

// src/action/post.ts
var runPost = async ({
  env = process.env,
  stdout
} = {}) => {
  const core = createCore({ env, stdout });
  const path = core.getState(CREDENTIALS_PATH_STATE);
  if (!path) return 0;
  try {
    await rm(path, { force: true });
    core.info(`Removed ${path}.`);
  } catch (error) {
    core.warning(`Couldn't remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
};
if (isEntryPoint(import.meta.url)) process.exitCode = await runPost();
export {
  runPost
};
