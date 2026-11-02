import { Option } from 'commander';

export interface CliOptions {
  args: string[];
  app?: string;
  platform?: string;
  targetId?: string;
  mode?: string;
  inputFile?: string;
  cookieFile?: string;
  profile?: string;
  runId?: string;
  json: boolean;
  yes: boolean;
  wait: boolean;
  timeoutMs: number;
  limit: number;
  all: boolean;
  archived: boolean;
  model?: string;
  reasoning?: string;
  attachments: string[];
  workspace?: string;
  noSkills: boolean;
  permission?: string;
  runtime?: string;
  project?: string;
  enterpriseKnowledge: boolean;
  expectJson: boolean;
  replySchema?: string;
  mcps: string[];
  commandPath?: string;
  commandArgs: string[];
  envPairs: string[];
  unknownFlags: string[];
  helpPath?: string[];
}

type ValueParser = (value: string | undefined) => string | number;
export interface OptionDefinition {
  flags: string;
  description: string;
  helpValue?: string;
  parse?: ValueParser;
  collect?: boolean;
  defaultValue?: unknown;
}
const required = (error: string, invalid: (value: string) => boolean = () => false): ValueParser => value => {
  if (!value || invalid(value)) throw new Error(error);
  return value;
};
const choice = (values: string[], error: string): ValueParser => value => {
  if (!value || !values.includes(value)) throw new Error(error);
  return value;
};
const numericId = (min: number, error: string): ValueParser => value => {
  if (!new RegExp(`^\\d{${min},24}$`, 'u').test(value || '')) throw new Error(error);
  return value!;
};
const pathValue = (error: string): ValueParser => required(error, value => value.startsWith('--'));

// Commander owns option parsing, defaults and collection. Keep legacy value
// validation messages here; command-specific business validation runs afterwards.
export const optionDefinitions: readonly OptionDefinition[] = [
  { flags: '-h, --help', description: 'Show help without executing the command' },
  { flags: '--json', description: 'Output results as JSON' },
  { flags: '--archived', description: 'List archived sessions instead of active sessions', helpValue: '' },
  { flags: '--all', description: 'Follow all session pages and remove duplicate IDs', helpValue: '' },
  { flags: '--yes', description: 'Confirm desktop CDP restart, or Headless local permission prompts' },
  { flags: '--wait', description: 'Wait for the reply after sending a message', helpValue: '' },
  { flags: '--run <id>', description: 'Select a run for a session operation', helpValue: '<id>', parse: numericId(12, '--run requires a numeric run id') },
  { flags: '--platform <platform>', description: 'Select work, doubao or headless; web aliases headless', parse: choice(['work', 'doubao', 'web', 'headless'], '--platform requires work, doubao, web, or headless') },
  { flags: '--app <app>', description: 'Compatibility alias for --platform (desktop only)', parse: choice(['work', 'doubao'], '--app requires work or doubao') },
  { flags: '--target <id>', description: 'Legacy CDP target (unsupported)', parse: required('--target requires a CDP target id', value => value.startsWith('-')) },
  { flags: '--file <path>', description: 'Read automation creation fields or update patch from JSON', helpValue: '<json-path>', parse: required('--file requires a JSON path', value => value.startsWith('-')) },
  { flags: '--mode <mode>', description: 'Select the mode for a new conversation', helpValue: 'chat|work|goal', parse: choice(['chat', 'work', 'goal'], '--mode requires chat or work (or goal on Desktop/Headless)') },
  { flags: '--cookie-file <path>', description: 'Import cookies from a session file during login', helpValue: '<path>', parse: pathValue('--cookie-file requires a file path') },
  { flags: '--profile <name>', description: 'Select an independent Headless account profile', helpValue: '<name>', parse: required('--profile requires a value') },
  { flags: '--timeout <seconds>', description: 'Set the request or wait budget', helpValue: '<seconds>', defaultValue: 120, parse: value => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout requires a positive number of seconds');
    return seconds;
  } },
  { flags: '--limit <count>', description: 'Limit the number of listed sessions', helpValue: '<count>', defaultValue: 20, parse: value => {
    const count = Number(value);
    if (!Number.isInteger(count) || count <= 0 || count > 1000) throw new Error('--limit requires an integer from 1 to 1000');
    return count;
  } },
  { flags: '--model <model>', description: 'Select an available model by its exact name', helpValue: '<model-name>', parse: required('--model requires a value') },
  { flags: '--reasoning <level>', description: 'Set reasoning effort', helpValue: 'low|medium|high|xhigh|max', parse: required('--reasoning requires a value') },
  { flags: '--attach <path>', description: 'Attach a file to a new message', helpValue: '<path>', collect: true, parse: pathValue('--attach requires a file path') },
  { flags: '--runtime <runtime>', description: 'Choose the task runtime', helpValue: 'local|cloud', parse: choice(['local', 'cloud'], '--runtime requires local or cloud') },
  { flags: '--project <id-or-name>', description: 'Set task project context', helpValue: '<id-or-name|none>', parse: required('--project requires a project id or exact name (none to clear)', value => !value.trim() || value.startsWith('--')) },
  { flags: '--enterprise-knowledge', description: 'Include enterprise knowledge in task context', helpValue: '' },
  { flags: '--workspace <path>', description: 'Set the task workspace', helpValue: '<path>', parse: pathValue('--workspace requires a directory path') },
  { flags: '--no-skills', description: 'Disable task skills', helpValue: '' },
  { flags: '--permission <mode>', description: 'Set local task permission mode', helpValue: '<mode>', parse: pathValue('--permission requires a mode: AlwaysAsk, AskOnRisk, or FullAccess') },
  { flags: '--expect-json', description: 'Require a JSON response', helpValue: '' },
  { flags: '--reply-schema <path>', description: 'Validate a JSON response against a schema', helpValue: '<path>', parse: pathValue('--reply-schema requires a JSON schema file path') },
  { flags: '--mcp <connector-id>', description: 'Use an MCP connector with a local task', helpValue: '<connector-id>', collect: true, parse: numericId(6, '--mcp requires a numeric connector id') },
  { flags: '--command <path>', description: 'Set the stdio MCP server executable', helpValue: '<path>', parse: pathValue('--command requires an executable path') },
  { flags: '--arg <value>', description: 'Add a stdio MCP server argument', helpValue: '<value>', collect: true, parse: value => {
    if (value === undefined) throw new Error('--arg requires a value');
    return value;
  } },
  { flags: '--env <KEY=VALUE>', description: 'Set a stdio MCP server environment variable', helpValue: 'KEY=VALUE', collect: true, parse: required('--env requires a KEY=VALUE pair', value => !value.includes('=')) },
];

export function headlessOptionLines(paths: string[][], allowed: (flag: string, command: string[], backend: string) => boolean): string[] {
  return optionDefinitions.flatMap(definition => {
    if (definition.helpValue === undefined) return [];
    const option = new Option(definition.flags);
    const flag = option.long!;
    const supports = (path: string[]) => flag === '--mcp'
      ? path[0] === 'sessions' && ['create', 'send'].includes(path[1])
      : allowed(flag, path, 'headless');
    return paths.some(supports) ? [`  ${flag}${definition.helpValue ? ` ${definition.helpValue}` : ''}  ${definition.description}`] : [];
  });
}
