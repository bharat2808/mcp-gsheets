import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  GoogleSheetsGateway,
  GoogleSheetsGatewayPolicy,
} from '../google/google-api-client.js';

interface GatewayContext {
  gateway: GoogleSheetsGateway;
  policy: GoogleSheetsGatewayPolicy;
}

const gatewayContext = new AsyncLocalStorage<GatewayContext>();

export function runWithGoogleSheetsGateway<T>(
  gateway: GoogleSheetsGateway,
  policy: GoogleSheetsGatewayPolicy,
  operation: () => Promise<T>
): Promise<T> {
  return gatewayContext.run({ gateway, policy }, operation);
}

export function currentGoogleSheetsGatewayPolicy(
  gateway: GoogleSheetsGateway
): GoogleSheetsGatewayPolicy | null {
  const context = gatewayContext.getStore();
  return context?.gateway === gateway ? context.policy : null;
}

export async function getAuthenticatedClient(): Promise<any> {
  const context = gatewayContext.getStore();
  if (!context) {
    throw new Error('Google Sheets operations require the connected Desktop OAuth gateway');
  }
  return context.gateway.getSheetsClient(context.policy);
}
