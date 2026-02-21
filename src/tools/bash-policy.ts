export const ALLOWED_COMMANDS = new Set([
  'git', 'ls', 'pwd', 'cat', 'mkdir', 'touch', 'echo', 'grep', 'find', 'rg'
]);

export const BLOCKED_COMMANDS = new Set(['rm', 'mv', 'cp', 'node', 'npm']);
export const BLOCKED_FLAGS_BY_COMMAND: Record<string, Set<string>> = {
  find: new Set(['-exec', '-execdir', '-ok', '-okdir']),
  rg: new Set(['--pre', '--pre-glob', '--no-ignore-files', '--ignore-file']),
  grep: new Set(['--include-from', '--exclude-from', '-f']),
  git: new Set(['-c', '--config-env', '--exec-path']),
};

export const PATH_FLAGS_BY_COMMAND: Record<string, Set<string>> = {
  git: new Set(['-C']),
  rg: new Set(['--ignore-file', '--pre']),
  grep: new Set(['--exclude-from', '--include-from', '-f']),
  find: new Set([]),
  ls: new Set([]),
  cat: new Set([]),
  mkdir: new Set([]),
  touch: new Set([]),
  pwd: new Set([]),
};

export const UNSAFE_SHELL_METACHARS = /[;&|><`\n\r]/;
export const MAX_OUTPUT_BYTES = 1_000_000;
export const MAX_FIND_DEPTH = 8;
export const MAX_SEARCH_MATCHES = 500;
export const GIT_ALLOWED_READONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'branch'
]);
export const GIT_ALLOWED_MUTATING_SUBCOMMANDS = new Set([
  'add', 'restore', 'commit', 'push', 'tag', 'stash'
]);
export const GIT_BLOCKED_DESTRUCTIVE_SUBCOMMANDS = new Set([
  'checkout', 'switch', 'reset', 'merge', 'rebase', 'cherry-pick'
]);
export const GIT_PATH_BEARING_FLAGS = new Set([
  '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path'
]);
export const PATH_ARG_COMMANDS = new Set(['ls', 'cat', 'mkdir', 'touch', 'find', 'rg', 'grep']);
