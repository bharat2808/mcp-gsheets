const SYSTEM_ENVIRONMENT_KEYS = [
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'SYSTEMROOT',
  'WINDIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
];

const SMOKE_OVERRIDE_KEYS = new Set(['GSHEETS_TOOL_CATEGORIES', 'GSHEETS_READ_ONLY']);

export function createSmokeChildEnvironment(
  parentEnvironment,
  dataDirectory,
  credentialService,
  overrides = {}
) {
  const environment = {
    NODE_ENV: 'test',
    GSHEETS_DATA_DIR: dataDirectory,
    GSHEETS_TEST_CREDENTIAL_SERVICE: credentialService,
  };
  for (const key of SYSTEM_ENVIRONMENT_KEYS) {
    if (typeof parentEnvironment[key] === 'string') {
      environment[key] = parentEnvironment[key];
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!SMOKE_OVERRIDE_KEYS.has(key)) {
      throw new Error(`Unsupported built-smoke environment override: ${key}`);
    }
    if (typeof value === 'string') {
      environment[key] = value;
    }
  }
  return environment;
}
