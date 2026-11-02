import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOptions } from '../src/cli.mjs';

const desktop = args => parseOptions(['--platform', 'doubao', ...args]);
const web = args => parseOptions(['--platform', 'web', ...args]);
const headless = args => parseOptions(['--platform', 'headless', ...args]);

test('all-session traversal is shared by Desktop and Headless and cannot silently ignore an explicit limit', () => {
  assert.equal(headless(['sessions', 'list', '--all']).all, true);
  assert.equal(headless(['sessions', 'list']).all, false);
  assert.equal(web(['sessions', 'list', '--all']).all, true);
  assert.equal(desktop(['sessions', 'list', '--all']).all, true);
  assert.throws(() => headless(['sessions', 'read', '38439138239851266', '--all']), /--all requires sessions list/u);
  for (const flags of [['--all', '--limit', '20'], ['--limit', '20', '--all']]) {
    for (const parse of [desktop, headless]) assert.throws(() => parse(['sessions', 'list', ...flags]), /--all cannot be combined with --limit/u);
  }
});

test('explicit confirmation and limits are accepted only where handlers use them', () => {
  assert.equal(desktop(['cdp', 'launch', '--yes']).yes, true);
  assert.throws(() => desktop(['sessions', 'create', 'hello', '--yes']), /--yes requires cdp launch/u);
  assert.throws(() => web(['cdp', 'launch', '--yes']), /(?:desktop platform|headless sessions create\/send\/wait)/u);
  assert.equal(headless(['sessions', 'create', 'hello', '--yes']).yes, true);
  assert.equal(headless(['sessions', 'send', '38439138239851266', 'hello', '--yes']).yes, true);
  assert.equal(headless(['sessions', 'wait', '38439138239851266', '--yes']).yes, true);
  assert.throws(() => headless(['sessions', 'list', '--yes']), /--yes requires headless sessions create\/send\/wait/u);
  assert.equal(headless(['sessions', 'list', '--limit', '8']).limit, 8);
  assert.equal(headless(['sessions', 'read', '38439138239851266', '--limit', '8']).limit, 8);
  assert.equal(web(['sessions', 'read', '38439138239851266', '--limit', '8']).limit, 8);
  assert.equal(desktop(['sessions', 'list', '--limit', '8']).limit, 8);
  assert.throws(() => desktop(['sessions', 'list', '--limit', '101']), /1 to 100/u);
  assert.equal(desktop(['sessions', 'list', '--timeout', '6']).timeoutMs, 6000);
  assert.equal(desktop(['projects', 'list', '--timeout', '6']).timeoutMs, 6000);
  assert.throws(() => headless(['sessions', 'create', 'hello', '--limit', '8']), /--limit requires sessions list or read/u);
});

test('model, mode, run, and timeout are command-scoped', () => {
  assert.equal(desktop(['sessions', 'create', 'hello', '--model', 'A']).model, 'A');
  assert.throws(() => desktop(['sessions', 'list', '--model', 'A']), /--model requires sessions create\/send/u);
  assert.equal(headless(['sessions', 'create', 'hello', '--mode', 'chat']).mode, 'chat');
  assert.throws(() => desktop(['sessions', 'create', 'hello', '--mode', 'chat']), /--mode requires/u);
  assert.throws(() => headless(['sessions', 'send', '38439138239851266', 'hello', '--mode', 'work']), /--mode requires/u);
  assert.equal(web(['sessions', 'wait', '38439138239851266', '--run', '123456789012']).runId, '123456789012');
  assert.throws(() => headless(['sessions', 'create', 'hello', '--run', '123456789012']), /--run requires sessions status\/wait\/stop/u);
  assert.equal(headless(['sessions', 'wait', '38439138239851266', '--timeout', '6']).timeoutMs, 6000);
  assert.throws(() => desktop(['sessions', 'status', '38439138239851266', '--timeout', '6']), /--timeout is not valid/u);
  assert.throws(() => headless(['capabilities', '--timeout', '6']), /--timeout is not valid/u);
  for (const command of [['profiles'], ['usage'], ['runtimes'], ['projects', 'list'], ['projects', 'create', 'New project'], ['model', 'current'], ['model', 'select', 'model-id'], ['model', 'reasoning', 'high']]) {
    assert.equal(headless([...command, '--timeout', '6']).timeoutMs, 6000, command.join(' '));
  }
  for (const command of [['capabilities'], ['logout'], ['update']]) {
    assert.throws(() => headless([...command, '--timeout', '6']), /--timeout is not valid/u, command.join(' '));
  }
  assert.equal(headless(['model', 'current', '--profile', 'work']).profile, 'work');
  assert.equal(headless(['model', 'select', 'model-id', '--reasoning', 'high']).reasoning, 'high');
  assert.equal(headless(['logout', '--profile', 'work']).profile, 'work');
  assert.equal(headless(['projects', 'list', '--profile', 'work']).profile, 'work');
  for (const command of [['capabilities'], ['update'], ['profiles']]) {
    assert.throws(() => headless([...command, '--profile', 'work']), /--profile is not valid/u, command.join(' '));
  }
  assert.throws(() => desktop(['capabilities', '--profile', 'work']), /--profile is not valid/u);
  assert.throws(() => desktop(['sessions', 'create', '--reasoning', 'high']), /--reasoning requires a message/u);
});

test('Headless local options infer local runtime and MCP permits attachments and background execution', () => {
  const options = headless(['sessions', 'create', 'hello', '--permission', 'AskOnRisk', '--mcp', '123456', '--attach', '/tmp/input.txt']);
  assert.equal(options.permission, 'AskOnRisk');
  assert.deepEqual(options.mcps, ['123456']);
  assert.deepEqual(options.attachments, ['/tmp/input.txt']);
  assert.equal(options.wait, false);
  assert.equal(headless(['sessions', 'create', 'hello', '--permission', 'AlwaysAsk']).permission, 'AlwaysAsk');
  assert.throws(() => headless(['sessions', 'create', 'hello', '--runtime', 'cloud', '--permission', 'AskOnRisk']), /--runtime cloud cannot use/u);
});

test('Headless chat rejects task options before contacting the backend', () => {
  for (const flags of [['--runtime', 'cloud'], ['--project', 'none'], ['--enterprise-knowledge'],
    ['--workspace', '/tmp'], ['--no-skills'], ['--permission', 'FullAccess'], ['--mcp', '123456']]) {
    assert.throws(() => headless(['sessions', 'create', 'hello', '--mode', 'chat', ...flags]), /requires --mode work/u);
  }
});

test('runtime and reply checks stay on task operations', () => {
  assert.equal(headless(['sessions', 'create', 'hello', '--runtime', 'cloud']).runtime, 'cloud');
  assert.throws(() => desktop(['sessions', 'status', '38439138239851266', '--runtime', 'cloud']), /Task context options require sessions create\/send/u);
  assert.equal(desktop(['sessions', 'create', 'hello', '--wait', '--expect-json']).expectJson, true);
  assert.equal(headless(['sessions', 'wait', '38439138239851266', '--reply-schema', '/tmp/reply.schema.json']).replySchema, '/tmp/reply.schema.json');
  assert.throws(() => desktop(['sessions', 'create', 'hello', '--expect-json']), /require --wait/u);
  assert.equal(desktop(['projects', 'create', 'name', '--workspace', process.cwd()]).workspace, process.cwd());
  assert.throws(() => desktop(['sessions', 'create', '--wait']), /--wait requires a message/u);
});

test('unknown flags fail on desktop and literal text after -- is preserved', () => {
  assert.throws(() => desktop(['sessions', 'list', '--not-an-option']), /Unknown option: --not-an-option/u);
  assert.throws(() => web(['sessions', 'list', '--not-an-option']), /Unknown Headless option: --not-an-option/u);
  assert.throws(() => headless(['sessions', 'list', '--not-an-option']), /Unknown Headless option: --not-an-option/u);
  const literal = headless(['sessions', 'create', '--', 'literal', '--not-an-option']);
  assert.deepEqual(literal.args, ['sessions', 'create', 'literal', '--not-an-option']);
  assert.deepEqual(literal.unknownFlags, []);
});

test('help bypasses execution option validation', () => {
  const parsed = headless(['sessions', 'read', '--yes', '--limit', '8', '--help']);
  assert.deepEqual(parsed.helpPath, ['sessions', 'read']);
});

test('non-message commands reject extra or missing positional operands before execution', () => {
  const cases = [
    [desktop, ['status', 'extra'], /status accepts no positional arguments/u],
    [web, ['capabilities', 'extra'], /capabilities accepts no positional arguments/u],
    [headless, ['models', 'extra'], /models accepts no positional arguments/u],
    [headless, ['sessions', 'list', 'extra'], /sessions list accepts no positional arguments/u],
    [headless, ['sessions', 'current', 'extra'], /sessions current accepts no positional arguments/u],
    [headless, ['sessions', 'read'], /sessions read requires exactly one conversation ID/u],
    [headless, ['sessions', 'open', '12345678901234', 'extra'], /sessions open requires exactly one conversation ID/u],
    [headless, ['sessions', 'wait', '12345678901234', 'extra'], /sessions wait requires exactly one conversation ID/u],
    [desktop, ['cdp', 'status', 'extra'], /cdp status accepts no positional arguments/u],
    [desktop, ['mcp', 'list', 'extra'], /mcp list accepts no positional arguments/u],
    [headless, ['mcp', 'remove', '123456', 'extra'], /mcp remove requires exactly one connector ID/u],
    [headless, ['projects', 'list', 'extra'], /projects list accepts no positional arguments/u],
    [headless, ['model', 'current', 'extra'], /model current accepts no positional arguments/u],
    [headless, ['update', 'auto', 'on', 'extra'], /update auto accepts one optional action/u],
  ];
  for (const [parse, args, expected] of cases) assert.throws(() => parse(args), expected, args.join(' '));
});

test('variable-length names and messages remain intact, while headless read limits are bounded', () => {
  assert.deepEqual(desktop(['model', 'select', 'A model with spaces']).args, ['model', 'select', 'A model with spaces']);
  assert.deepEqual(desktop(['projects', 'create', 'A project name']).args, ['projects', 'create', 'A project name']);
  assert.deepEqual(headless(['mcp', 'register', 'A connector name', '--command', '/usr/bin/node']).args,
    ['mcp', 'register', 'A connector name']);
  assert.equal(headless(['sessions', 'read', '12345678901234', '--limit', '100']).limit, 100);
  assert.throws(() => headless(['sessions', 'read', '12345678901234', '--limit', '101']), /1 to 100/u);
  assert.equal(desktop(['sessions', 'read', '12345678901234', '--limit', '101']).limit, 101);
  assert.equal(headless(['sessions', 'create', 'a message with spaces', '--', 'literal']).args.at(-1), 'literal');
  assert.equal(headless(['sessions', 'create', '--', 'a', 'message', 'with', 'spaces']).args.slice(2).join(' '), 'a message with spaces');
});

test('headless draft creation rejects task flags that would otherwise be ignored', () => {
  for (const flag of [
    ['--attach', '/tmp/file'], ['--mode', 'chat'], ['--model', 'model-id'], ['--reasoning', 'high'],
    ['--runtime', 'cloud'], ['--project', 'none'], ['--enterprise-knowledge'], ['--workspace', process.cwd()],
    ['--no-skills'], ['--permission', 'FullAccess'], ['--mcp', '123456'], ['--expect-json'], ['--reply-schema', '/tmp/schema.json'],
  ]) {
    assert.throws(() => headless(['sessions', 'create', ...flag]), /requires a message in Headless sessions create/u, flag.join(' '));
  }
  assert.deepEqual(headless(['sessions', 'create']).args, ['sessions', 'create']);
  assert.deepEqual(headless(['sessions', 'create', '--profile', 'work', '--json']).args, ['sessions', 'create']);
});

test('headless MCP options and project workspaces are recognized only where consumed', () => {
  assert.equal(headless(['mcp', 'list', '--timeout', '4']).timeoutMs, 4000);
  assert.equal(headless(['mcp', 'remove', '123456', '--profile', 'work', '--timeout', '4']).profile, 'work');
  assert.equal(headless(['mcp', 'register', 'Local connector', '--command', '/usr/bin/node', '--arg', 'x', '--env', 'TOKEN=secret', '--timeout', '4']).commandArgs[0], 'x');
  assert.equal(headless(['projects', 'create', 'Workspace project', '--workspace', process.cwd()]).workspace, process.cwd());
  assert.throws(() => headless(['mcp', 'list', '--command', '/usr/bin/node']), /--command is not valid/u);
});
