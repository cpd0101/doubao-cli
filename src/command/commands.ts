import { Command } from 'commander';

export type HelpPlatform = 'desktop' | 'headless';
export interface CommandDefinition { path: string; desktop?: string; headless?: string }

// Usage operands are separate from command paths. Business dispatch stays in cli.mjs.
export const commands: readonly CommandDefinition[] = [
  {"path": "skin", "desktop": "<on|off|status> [--json]", "headless": "<on|off|status> [--json]"},
  {"path": "status", "desktop": "[--profile <name>] [--json]", "headless": "[--json]"},
  {"path": "usage", "desktop": "[--profile <name>] [--json]", "headless": "[--profile <name>] [--timeout <seconds>] [--json]"},
  {"path": "profiles", "desktop": "[--json]", "headless": "[--json]"},
  {"path": "runtimes", "desktop": "[--json]", "headless": "[--json]"},
  {"path": "keepalive status", "headless": "[--profile <name>] [--json]"},
  {"path": "keepalive stop", "headless": "[--profile <name>] [--json]"},
  {"path": "projects list", "desktop": "[--timeout <seconds>] [--json]", "headless": "[--profile <name>] [--timeout <seconds>] [--json]"},
  {"path": "projects create", "desktop": "<name> [--workspace <path>] [--json]", "headless": "<name> [--profile <name>] [--timeout <seconds>] [--json]"},
  {"path": "sessions list", "desktop": "[--all | --limit <count>] [--archived] [--profile <name>] [--timeout <seconds>] [--json]", "headless": "[--all | --limit <count>] [--archived] [--json]"},
  {"path": "sessions current", "desktop": "[--profile <name>] [--json]", "headless": "[--profile <name>] [--json]"},
  {"path": "sessions archive", "desktop": "<conversation-id> [--timeout <seconds>] [--json]", "headless": "<conversation-id> [--timeout <seconds>] [--json]"},
  {"path": "sessions unarchive", "desktop": "<conversation-id> [--timeout <seconds>] [--json]", "headless": "<conversation-id> [--timeout <seconds>] [--json]"},
  {"path": "sessions pin", "desktop": "<conversation-id> [--timeout <seconds>] [--json]", "headless": "<conversation-id> [--timeout <seconds>] [--json]"},
  {"path": "sessions unpin", "desktop": "<conversation-id> [--timeout <seconds>] [--json]", "headless": "<conversation-id> [--timeout <seconds>] [--json]"},
  {"path": "sessions rename", "desktop": "<conversation-id> <title> [--timeout <seconds>] [--json]", "headless": "<conversation-id> <title> [--timeout <seconds>] [--json]"},
  {"path": "sessions move", "desktop": "<conversation-id> <project-id-or-name|none> [--timeout <seconds>] [--json]", "headless": "<conversation-id> <project-id-or-name|none> [--timeout <seconds>] [--json]"},
  {"path": "sessions create", "desktop": "[message] [--mode goal] [--attach <path>] [--model <model>] [--reasoning <level>] [--wait] [--timeout <seconds>] [--runtime local|cloud] [--project <id-or-name|none>] [--enterprise-knowledge] [--workspace <path>] [--no-skills] [--mcp <connector-id>]... [--permission <mode>] [--expect-json] [--reply-schema <path>] [--json]", "headless": "<message> [--mode chat|work|goal] [--model <model-name>] [--wait] [--timeout <seconds>] [--yes] [--json]"},
  {"path": "sessions open", "desktop": "<conversation-id>", "headless": "<conversation-id> [--profile <name>] [--json]"},
  {"path": "sessions read", "desktop": "<conversation-id> [--limit <count>] [--json]", "headless": "<conversation-id> [--limit <count>] [--json]"},
  {"path": "sessions send", "desktop": "<conversation-id> <message> [--attach <path>] [--model <model>] [--reasoning <level>] [--wait] [--timeout <seconds>] [--runtime local|cloud] [--project <id-or-name|none>] [--enterprise-knowledge] [--workspace <path>] [--no-skills] [--mcp <connector-id>]... [--permission <mode>] [--expect-json] [--reply-schema <path>] [--json]", "headless": "<conversation-id> <message> [--model <model-name>] [--wait] [--timeout <seconds>] [--yes] [--json]"},
  {"path": "sessions status", "desktop": "<conversation-id> [--run <run-id>] [--json]", "headless": "<conversation-id> [--run <run-id>] [--json]"},
  {"path": "sessions wait", "desktop": "<conversation-id> [--run <run-id>] [--timeout <seconds>] [--expect-json] [--reply-schema <path>] [--json]", "headless": "<conversation-id> [--run <run-id>] [--timeout <seconds>] [--yes] [--json]"},
  {"path": "sessions stop", "desktop": "<conversation-id> [--run <run-id>] [--json]", "headless": "<conversation-id> [--run <run-id>] [--timeout <seconds>] [--json]"},
  {"path": "mcp register", "desktop": "<name> --command <path> [--arg <x>]... [--env K=V]... [--json]", "headless": "<name> --command <executable> [--arg <value>] [--env KEY=VALUE] [--json]"},
  {"path": "mcp list", "desktop": "[--json]", "headless": "[--profile <name>] [--json]"},
  {"path": "mcp remove", "desktop": "<connector-id> [--json]", "headless": "<connector-id> [--profile <name>] [--json]"},
  {"path": "models", "desktop": "[--json]", "headless": "[--json]"},
  {"path": "model", "desktop": "[--json]"},
  {"path": "model current", "desktop": "[--json]", "headless": "[--profile <name>] [--json]"},
  {"path": "model select", "desktop": "<model> [--reasoning <level>] [--json]", "headless": "<model-name> [--reasoning <level>] [--profile <name>] [--json]"},
  {"path": "model reasoning", "desktop": "<level> [--json]", "headless": "<level> [--profile <name>] [--json]"},
  {"path": "cdp status", "desktop": "[--json]"},
  {"path": "cdp launch", "desktop": "[--yes] [--json]"},
  {"path": "update", "desktop": "[--json]", "headless": "[--json]"},
  {"path": "update check", "desktop": "[--json]", "headless": "[--json]"},
  {"path": "update auto", "desktop": "<on|off|status> [--json]", "headless": "<on|off|status> [--json]"},
  {"path": "update notify", "desktop": "<on|off|status> [--json]", "headless": "<on|off|status> [--json]"},
  {"path": "capabilities", "desktop": "[--json]", "headless": "[--json]"},
  {"path": "automations list", "desktop": "[--json]", "headless": "[--json]"},
  {"path": "automations get", "desktop": "<id> [--json]", "headless": "<id> [--json]"},
  {"path": "automations create", "desktop": "--file <json-path> [--json]", "headless": "--file <json-path> [--json]"},
  {"path": "automations update", "desktop": "<id> --file <json-path> [--json]", "headless": "<id> --file <json-path> [--json]"},
  {"path": "automations delete", "desktop": "<id> [--json]", "headless": "<id> [--json]"},
  {"path": "login", "headless": "[--cookie-file <path>] [--timeout <seconds>] [--json]"},
  {"path": "logout", "headless": "[--json]"},
 ];

export function commandTree(platform: HelpPlatform): Command {
  const root = new Command('doubao').helpOption(false).addHelpCommand(false);
  for (const definition of commands) {
    const usage = definition[platform];
    if (usage === undefined) continue;
    let command = root;
    for (const name of definition.path.split(' ')) {
      let child = command.commands.find(item => item.name() === name);
      if (!child) {
        child = new Command(name).helpOption(false).addHelpCommand(false);
        command.addCommand(child);
      }
      command = child;
    }
    command.usage(usage || ' ');
  }
  return root;
}

export function helpEntries(platform?: string): { line: string; path: string[] }[] {
  const backend: HelpPlatform = platform === 'headless' ? 'headless' : 'desktop';
  const root = commandTree(backend);
  return commands.filter(definition => definition[backend] !== undefined).map(definition => {
    const parts = definition.path.split(' ');
    let command = root;
    for (const part of parts) command = command.commands.find(item => item.name() === part)!;
    const suffix = command.usage().trim();
    return { path: parts, line: `  doubao${backend === 'headless' ? ' headless' : ''} ${definition.path}${suffix ? ` ${suffix}` : ''}` };
  });
}
