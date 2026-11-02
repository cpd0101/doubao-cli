import { helpEntries } from './commands.js';

const DESKTOP_SELECTORS = `  --platform work|doubao|headless  Select a backend; web is an alias for headless
  --app work|doubao  Compatibility alias for --platform (desktop only)`;
const HEADLESS_SELECTOR = '  --platform headless  Select Headless; equivalent to doubao headless';

const DESKTOP_NOTES = `Help:
  Add --help or -h to any command, or use help <command>.
  --  Treat the remaining arguments as literal text, including help and --help.

Local task execution permission (requires --runtime local or --mcp):
  --permission <mode>  AlwaysAsk | AskOnRisk | FullAccess (default)
                      Repeat on each turn; approval is handled by Doubao.
                      This does not guarantee approval for each MCP call.

Application:
${DESKTOP_SELECTORS}
  Default on macOS: Work if installed, otherwise Doubao. Linux defaults to Headless.
  If both selectors are supplied, they must select the same backend.
  --mode chat|work|goal  Select a new conversation mode (goal: Desktop/Headless, Doubao >=2.32.10)

Environment:
  DOUBAO_APP       Override the application path
  DOUBAO_DATA_DIR  Override the Doubao user-data directory
  DOUBAO_CDP_ENDPOINT  Desktop CDP endpoint (Work: 9226; Doubao: 9225)
  DOUBAO_CLI_CONFIG_DIR  Override the doubao-cli settings directory
  DOUBAO_CLI_CONNECTION_BADGE  Set to 1 to show the desktop connection badge (default: hidden)
  DOUBAO_CLI_DISABLE_AUTO_UPDATE  Set to 1 to skip automatic updates and reminders
`;
const HEADLESS_NOTES = `Help:
  Add --help or -h to any command, or use help <command>.
  --  Treat the remaining arguments as literal text, including help and --help.

Options:
${HEADLESS_SELECTOR}
  --mode chat|work|goal  Select the mode for a new conversation
  --model <model-name>  Select an available model by its exact name from headless models
  --reasoning low|medium|high|xhigh|max  Set reasoning effort
  --profile <name>  Select a separate saved Headless account profile
  --project <id-or-name|none>  Select a task project
  --enterprise-knowledge  Include the account's enterprise search skill
  --runtime local|cloud  Work task runtime (default: cloud; local options select local)
  --attach <path>  Upload a file or image; repeat for multiple attachments
  --workspace <path> / --no-skills  Configure local task files and skills
  --permission FullAccess|AskOnRisk|AlwaysAsk  New: AskOnRisk; follow-ups inherit; FullAccess requires confirmation
  --yes  Confirm FullAccess / local tool prompts without a TTY answer (create/send/wait)
  --mcp <connector-id>  Use a registered stdio connector with local tasks; repeat as needed
  --timeout <seconds>  Request or wait budget (default: 120)
  --expect-json / --reply-schema <path>  Validate the final reply; create/send require --wait
  --json  Output results as JSON
  --  Treat the remaining arguments as message text

Account:
  Account login is required. Run "doubao headless login" and scan the terminal QR code with the Doubao mobile app.
  --cookie-file imports session cookies for unattended setup; cookie files are secrets. No installed browser or local Doubao app is required.
  Local tasks use Node.js processes and file tools. No OS sandbox is created.
  Without --wait, local tasks continue in a detached worker; approval policies deny calls that need a prompt.
  DOUBAO_HEADLESS_COOKIE supplies an in-memory session; explicit login verifies and saves it.

Compatibility:
  doubao web <command> and --platform web are aliases for Headless, including login.
  Run "doubao help" for desktop and update commands.
`;

export function rootHelp(platform?: string): string {
  const headless = platform === 'headless';
  const lines = helpEntries(platform).map(entry => entry.line);
  if (!headless) lines.push('  doubao web <command> [options]  Compatibility alias for "doubao headless"', '  doubao headless <command> [options]  Browser-free commands; run "doubao headless help"');
  return `Usage:
${lines.join('\n')}

${headless ? HEADLESS_NOTES : DESKTOP_NOTES}`;
}

export function helpCommandPath(args: string[], platform?: string) {
  if (!args.length) return [];
  if (['version', '--version', '-v'].includes(args[0])) return ['version'];
  const entries = helpEntries(platform);
  const matches = entries.filter(entry => entry.path[0] === args[0]);
  if (!matches.length) throw new Error(`Unknown help topic: ${args.join(' ')}`);
  if (args.length > 1 && matches.some(entry => entry.path.length > 1)) {
    if (!matches.some(entry => entry.path[1] === args[1])) throw new Error(`Unknown help topic: ${args.slice(0, 2).join(' ')}`);
    return args.slice(0, 2);
  }
  return args.slice(0, 1);
}

export function commandHelp(helpPath: string[], platform: string | undefined, headlessOptionsForHelp: (path: string[]) => string[]) {
  const headless = platform === 'headless';
  if (!helpPath.length) return rootHelp(platform);
  const lines = helpPath[0] === 'version'
    ? [`  doubao${headless ? ' headless' : ''} --version`]
    : helpEntries(platform).filter(entry => helpPath.every((token, index) => entry.path[index] === token)).map(entry => entry.line);
  const options = helpPath[0] === 'skin'
    ? `${DESKTOP_SELECTORS}\n  --json  Output results as JSON`
    : headless
    ? [HEADLESS_SELECTOR, ...headlessOptionsForHelp(helpPath), '  --json  Output results as JSON'].join('\n')
    : `${DESKTOP_SELECTORS}\n  --profile <name>  Select a desktop profile\n  --json  Output results as JSON`;
  const permission = !headless && helpPath[0] === 'sessions' && (!helpPath[1] || ['create', 'send'].includes(helpPath[1]))
    ? `\n\nLocal task execution permission${rootHelp('desktop').split('\n\nLocal task execution permission')[1].split('\n\nApplication:')[0]}`
    : '';
  return `Usage:\n${lines.join('\n')}\n\nOptions:\n${options}\n  -h, --help  Show help without executing the command\n  --  Treat the remaining arguments as literal text${permission}\n`;
}
