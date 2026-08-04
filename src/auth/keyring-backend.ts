import { CredentialBackend } from './credential-vault.js';

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

export class KeyringBackend implements CredentialBackend {
  readonly #injectedFactory: KeyringEntryFactory | undefined;
  #loadedFactory: KeyringEntryFactory | null = null;

  constructor(factory?: KeyringEntryFactory) {
    this.#injectedFactory = factory;
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    return (await this.#entry(service, account)).getPassword();
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    (await this.#entry(service, account)).setPassword(password);
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    return (await this.#entry(service, account)).deletePassword();
  }

  async #entry(service: string, account: string): Promise<KeyringEntry> {
    if (this.#injectedFactory) {
      return this.#injectedFactory(service, account);
    }
    if (!this.#loadedFactory) {
      const { Entry } = await import('@napi-rs/keyring');
      this.#loadedFactory = (entryService, entryAccount) => new Entry(entryService, entryAccount);
    }
    return this.#loadedFactory(service, account);
  }
}
