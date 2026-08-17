import { describe, expect, it } from 'vitest';

import { argumentsFromInputSchema } from '../../scripts/smoke-schema-arguments.mjs';

describe('built smoke schema arguments', () => {
  it('derives valid required values, nested arrays, enums, and UUIDs', () => {
    expect(
      argumentsFromInputSchema({
        type: 'object',
        required: ['proposalId', 'operation', 'values'],
        properties: {
          proposalId: { type: 'string', format: 'uuid' },
          operation: { type: 'string', enum: ['append', 'update'] },
          values: {
            type: 'array',
            minItems: 1,
            items: { type: 'array', minItems: 1, items: { type: 'string' } },
          },
        },
      })
    ).toEqual({
      proposalId: '00000000-0000-4000-8000-000000000000',
      operation: 'append',
      values: [['smoke']],
    });
  });

  it('selects a concrete branch for union schemas', () => {
    expect(
      argumentsFromInputSchema({
        type: 'object',
        required: ['value'],
        properties: { value: { anyOf: [{ type: 'number', minimum: 2 }, { type: 'string' }] } },
      })
    ).toEqual({ value: 2 });
  });
});
