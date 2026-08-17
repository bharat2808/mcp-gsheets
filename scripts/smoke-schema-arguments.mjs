const SMOKE_UUID = '00000000-0000-4000-8000-000000000000';

function schemaValue(schema) {
  if (!schema || typeof schema !== 'object') return null;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const branch = union.find((candidate) => candidate?.type !== 'null') ?? union[0];
    return schemaValue(branch);
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((branch) => schemaValue(branch)));
  }
  if (schema.type === 'object' || schema.properties) {
    const properties = schema.properties ?? {};
    return Object.fromEntries(
      (schema.required ?? []).map((name) => [name, schemaValue(properties[name])])
    );
  }
  if (schema.type === 'array') {
    const count = Math.max(1, Number(schema.minItems ?? 0));
    return Array.from({ length: count }, () => schemaValue(schema.items));
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    const minimum = schema.minimum ??
      (typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + 1 : 0);
    return schema.type === 'integer' ? Math.ceil(minimum) : minimum;
  }
  if (schema.type === 'boolean') return true;
  if (schema.type === 'null') return null;
  if (schema.format === 'uuid') return SMOKE_UUID;
  if (schema.format === 'date-time') return '2026-08-06T00:00:00.000Z';
  if (schema.format === 'date') return '2026-08-06';
  return 'smoke'.padEnd(Math.max(5, Number(schema.minLength ?? 0)), 'x');
}

export function argumentsFromInputSchema(inputSchema) {
  const value = schemaValue(inputSchema);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
