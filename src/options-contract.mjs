import { headlessOptionLines } from '../dist/command/options.js';
import { SESSION_ACTIONS } from './session-actions.mjs';
const SESSION_CREATE_OR_SEND = command => command[0] === 'sessions' && ['create', 'send'].includes(command[1]);
const SESSION_STATE = command => command[0] === 'sessions' && ['status', 'wait', 'stop'].includes(command[1]);
const SESSION_LIST_OR_READ = command => command[0] === 'sessions'
  && ['read', 'list'].includes(command[1]);

function allowed(flag, command, backend) {
  if (command[0] === 'skin') return ['--json', '--app', '--platform'].includes(flag);
  const sessionMessage = SESSION_CREATE_OR_SEND(command);
  const sessionState = SESSION_STATE(command);
  switch (flag) {
    case '--yes':
      if (backend === 'desktop') return command[0] === 'cdp' && command[1] === 'launch';
      if (backend === 'headless') return command[0] === 'sessions' && ['create', 'send', 'wait'].includes(command[1]);
      return false;
    case '--limit': return SESSION_LIST_OR_READ(command);
    case '--archived': return command[0] === 'sessions' && command[1] === 'list';
    case '--all': return command[0] === 'sessions' && command[1] === 'list';
    case '--run': return sessionState;
    case '--mode': return command[0] === 'sessions' && command[1] === 'create';
    case '--file': return backend !== 'web' && command[0] === 'automations' && ['create', 'update'].includes(command[1]);
    case '--timeout':
      if (backend !== 'web' && command[0] === 'automations') return true;
      if (backend === 'headless') return ['login', 'status', 'models', 'profiles', 'usage', 'runtimes'].includes(command[0])
        || command[0] === 'keepalive' && ['status', 'stop'].includes(command[1])
        || command[0] === 'sessions' || command[0] === 'projects' && ['list', 'create'].includes(command[1])
        || command[0] === 'model' && (!command[1] || ['current', 'select', 'reasoning'].includes(command[1]))
        || command[0] === 'mcp' && ['register', 'list', 'remove'].includes(command[1]);
      if (backend === 'web') return command[0] === 'login' || command[0] === 'sessions'
        && ['open', 'read', 'create', 'send', 'status', 'wait', 'stop'].includes(command[1]);
      return sessionMessage || command[0] === 'projects' && command[1] === 'list'
        || command[0] === 'sessions' && ['list', 'read', 'wait', 'stop', ...SESSION_ACTIONS].includes(command[1])
        || command[0] === 'mcp' && command[1] === 'register';
    case '--target': return backend === 'web' && ['login', 'status', 'cdp', 'sessions'].includes(command[0]);
    case '--profile':
      if (backend === 'web') return false;
      if (backend === 'headless') return ['automations', 'login', 'logout', 'status', 'models', 'usage', 'runtimes', 'projects', 'model', 'mcp', 'sessions', 'keepalive'].includes(command[0]);
      return ['automations', 'status', 'usage', 'runtimes', 'projects', 'sessions', 'mcp', 'models', 'model'].includes(command[0]);
    case '--cookie-file': return backend === 'headless' && command[0] === 'login';
    case '--model': return ['desktop', 'headless'].includes(backend) && sessionMessage;
    case '--reasoning': return ['desktop', 'headless'].includes(backend) && (sessionMessage
      || ['desktop', 'headless'].includes(backend) && command[0] === 'model' && command[1] === 'select');
    case '--attach': return ['desktop', 'headless'].includes(backend) && sessionMessage;
    case '--runtime': return sessionMessage;
    case '--project': case '--enterprise-knowledge': case '--workspace': case '--no-skills':
    case '--permission':
      return ['desktop', 'headless'].includes(backend) && (sessionMessage || flag === '--workspace'
        && ['desktop', 'headless'].includes(backend) && command[0] === 'projects' && command[1] === 'create');
    case '--mcp': return true; // Existing MCP validation preserves permission and wait error ordering.
    case '--expect-json': case '--reply-schema':
      return command[0] === 'sessions' && ['create', 'send', 'wait'].includes(command[1]);
    case '--wait': return sessionMessage;
    case '--command': case '--arg': case '--env': return ['desktop', 'headless'].includes(backend) && command[0] === 'mcp' && command[1] === 'register';
    default: return true;
  }
}

/** Options actually accepted by the Headless contract for a help topic. */
export function headlessOptionsForHelp(helpPath) {
  const paths = [helpPath];
  if (helpPath.length === 1) {
    const children = {
      sessions: ['list', 'current', 'open', 'read', 'create', 'send', 'status', 'wait', 'stop'],
      projects: ['list', 'create'],
      automations: ['list', 'get', 'create', 'update', 'delete'],
      mcp: ['register', 'list', 'remove'],
      model: ['current', 'select', 'reasoning'],
      keepalive: ['status', 'stop'],
    }[helpPath[0]] || [];
    paths.push(...children.map(child => [...helpPath, child]));
  }
  return headlessOptionLines(paths, allowed);
}

function optionError(flag, command, backend) {
  const webUnsupported = ['--profile', '--attach', '--model', '--reasoning', '--runtime', '--project',
    '--enterprise-knowledge', '--workspace', '--no-skills', '--permission', '--mcp', '--command', '--arg', '--env'];
  if (backend === 'web' && webUnsupported.includes(flag)) {
    return `${flag} is not supported on doubao web; use a desktop platform for task features`;
  }
  if (backend === 'headless' && flag === '--target') return '--target is not supported on doubao headless';
  if (flag === '--run') return '--run requires sessions status/wait/stop';
  if (flag === '--mode') return '--mode requires doubao web sessions create or doubao headless sessions create (or a matching --platform selector)';
  if (flag === '--timeout') return `${flag} is not valid for ${command.join(' ') || 'this command'}`;
  if (flag === '--yes') {
    if (backend === 'headless') return '--yes requires headless sessions create/send/wait';
    return '--yes requires cdp launch on a desktop platform';
  }
  if (flag === '--limit') return '--limit requires sessions list or read';
  if (flag === '--archived') return '--archived requires sessions list';
  if (flag === '--all') return '--all requires sessions list';
  if (flag === '--target' && backend === 'web') return `--target is not used by doubao web ${command.join(' ')}`;
  if (flag === '--target') return '--target requires doubao web';
  if (flag === '--cookie-file') return '--cookie-file requires doubao headless login';
  if (flag === '--model') return `${flag} requires sessions create/send`;
  if (['--runtime', '--project', '--enterprise-knowledge'].includes(flag)) return 'Task context options require sessions create/send';
  if (flag === '--permission') return '--permission requires sessions create/send with --runtime local or --mcp';
  if (flag === '--wait') return `${backend === 'headless' ? 'Headless' : backend === 'web' ? 'Web' : 'Desktop'} --wait requires sessions create/send with a message`;
  if (flag === '--expect-json' || flag === '--reply-schema') return '--expect-json and --reply-schema require sessions create/send/wait';
  return `${flag} is not valid for ${command.join(' ') || 'this command'} on ${backend}`;
}

function validatePositionalContract(options) {
  const args = options.args || [];
  const [command, subcommand] = args;
  const fail = message => { throw new Error(message); };
  const exact = (count, message) => { if (args.length !== count) fail(message); };
  const minimum = (count, message) => { if (args.length < count) fail(message); };

  if (['status', 'capabilities', 'models', 'usage', 'profiles', 'runtimes'].includes(command)) exact(1, `${command} accepts no positional arguments`);
  if (command === 'keepalive') {
    if (!['status', 'stop'].includes(subcommand)) fail('keepalive requires status or stop');
    exact(2, `keepalive ${subcommand || ''} accepts no positional arguments`.replace(/\s+/gu, ' ').trim());
  }
  if (command === 'skin' && (args.length > 2 || !['on', 'off', 'status'].includes(subcommand || 'status'))) {
    fail('skin accepts on, off, or status');
  }
  if (command === 'automations') {
    if (!['list', 'get', 'create', 'update', 'delete'].includes(subcommand)) fail('automations requires list, get, create, update, or delete');
    exact(['list', 'create'].includes(subcommand) ? 2 : 3, `automations ${subcommand} ${['list', 'create'].includes(subcommand) ? 'accepts no positional arguments' : 'requires exactly one task ID'}`);
  }
  if (command === 'sessions') {
    if (['list', 'current'].includes(subcommand)) exact(2, `sessions ${subcommand} accepts no positional arguments`);
    if (['archive', 'unarchive', 'pin', 'unpin'].includes(subcommand)) exact(3, `sessions ${subcommand} requires exactly one conversation ID`);
    if (['rename', 'move'].includes(subcommand)) minimum(4, `sessions ${subcommand} requires a conversation ID and ${subcommand === 'rename' ? 'title' : 'project ID, exact name, or none'}`);
    if (['read', 'open', 'status', 'wait', 'stop'].includes(subcommand)) exact(3, `sessions ${subcommand} requires exactly one conversation ID`);
  }
  if (command === 'cdp' && ['status', 'launch'].includes(subcommand)) exact(2, `cdp ${subcommand} accepts no positional arguments`);
  if (command === 'update') {
    if (!subcommand || subcommand === 'check') exact(subcommand ? 2 : 1, `update${subcommand ? ' check' : ''} accepts no positional arguments`);
    if (['auto', 'notify'].includes(subcommand) && args.length > 3) fail(`update ${subcommand} accepts one optional action: on, off, or status`);
  }
  if (command === 'mcp') {
    if (subcommand === 'list') exact(2, 'mcp list accepts no positional arguments');
    if (subcommand === 'remove') exact(3, 'mcp remove requires exactly one connector ID');
    if (subcommand === 'register') minimum(3, 'mcp register requires a connector name');
  }
  if (command === 'projects' && subcommand === 'list') exact(2, 'projects list accepts no positional arguments');
  if (command === 'projects' && subcommand === 'create') minimum(3, 'projects create requires a project name');
  if (command === 'model') {
    if (!subcommand) exact(1, 'model accepts no positional arguments');
    if (subcommand === 'current') exact(2, 'model current accepts no positional arguments');
    if (subcommand === 'select') minimum(3, 'model select requires a model name');
    if (subcommand === 'reasoning') exact(3, 'model reasoning requires exactly one effort level');
  }
}

/** Validate explicit option placement before any backend or update work begins. */
export function validateOptionContract(options, backend) {
  options = { ...options, backend };
  const [command, subcommand] = options.args;
  const path = [command, subcommand].filter(Boolean);
  const versionOnly = options.args.length === 1 && ['--version', '-v'].includes(command);
  const unknown = (options.unknownFlags || []).find(flag => !(versionOnly && flag === command));
  if (unknown) {
    if (command === 'projects' && subcommand === 'create') {
      throw new Error(`Unknown projects create option: ${unknown}. Run "doubao help"; use -- before a name starting with -`);
    }
    const label = backend === 'web' ? 'Web' : backend === 'headless' ? 'Headless' : '';
    throw new Error(`Unknown ${label ? `${label} ` : ''}option: ${unknown}; use -- before literal text`);
  }

  if (backend === 'headless' && options.args[0] === 'sessions' && options.args[1] === 'create'
    && !options.args.slice(2).join(' ').trim()) {
    const noMessageOptions = ['--attach', '--mode', '--model', '--reasoning', '--runtime', '--project',
      '--enterprise-knowledge', '--workspace', '--no-skills', '--permission', '--mcp', '--expect-json', '--reply-schema', '--wait'];
    const ignored = (options.explicitOptions || []).find(flag => noMessageOptions.includes(flag));
    if (ignored) throw new Error(`${ignored} requires a message in Headless sessions create`);
  }

  if (backend === 'headless' && options.mode === 'chat' && SESSION_CREATE_OR_SEND(path)) {
    const workOnly = ['--runtime', '--project', '--enterprise-knowledge', '--workspace', '--no-skills', '--permission', '--mcp'];
    const invalid = (options.explicitOptions || []).find(flag => workOnly.includes(flag));
    if (invalid) throw new Error(`${invalid} requires --mode work on doubao headless`);
  }

  for (const flag of options.explicitOptions || []) {
    if (!allowed(flag, path, backend)) throw new Error(optionError(flag, path, backend));
    if (flag === '--reasoning' && SESSION_CREATE_OR_SEND(path)) {
      const message = options.args.slice(path[1] === 'create' ? 2 : 3).join(' ').trim();
      if (!message) throw new Error('--reasoning requires a message');
    }
    if (flag === '--wait' && SESSION_CREATE_OR_SEND(path)) {
      const message = options.args.slice(path[1] === 'create' ? 2 : 3).join(' ').trim();
      if (!message && !options.expectJson && !options.replySchema) {
        throw new Error(`${backend === 'headless' ? 'Headless ' : backend === 'web' ? 'Web ' : ''}--wait requires a message`);
      }
    }
  }

  if (options.all && options.explicitOptions?.includes('--limit')) throw new Error('--all cannot be combined with --limit');
  if (options.limit > 100 && options.args[0] === 'sessions'
    && (options.args[1] === 'list' || backend === 'headless' && options.args[1] === 'read')) {
    throw new Error('--limit requires an integer from 1 to 100 for session lists and Headless reads');
  }
  validatePositionalContract(options);
}
