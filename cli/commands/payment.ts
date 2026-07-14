import { BaseCommand } from './install.interface';

export interface PaymentOptions {
  show?: boolean;
  card?: boolean;
  crypto?: boolean;
  gateway?: string;
  cardHolder?: string;
  cardNumber?: string;
  iban?: string;
  network?: string;
  address?: string;
}

export class PaymentCommand extends BaseCommand {
  async execute(options: PaymentOptions): Promise<void> {
    this.section('Payment Gateway Settings');

    if (options.show) {
      await this.showSettings();
      return;
    }

    if (options.card || options.crypto) {
      await this.configure(options);
      return;
    }

    await this.showMenu();
  }

  private async showMenu(): Promise<void> {
    const action = await this.select('Choose a payment configuration action', [
      { value: 'show', label: 'Show current payment settings' },
      { value: 'card', label: 'Configure card-to-card gateway' },
      { value: 'crypto', label: 'Configure crypto gateway' },
      { value: 'exit', label: 'Exit' },
    ]);

    if (action === 'exit') {
      this.log('No changes applied.', 'info');
      return;
    }

    if (action === 'show') {
      await this.showSettings();
      return;
    }

    await this.configure({
      card: action === 'card',
      crypto: action === 'crypto',
    });
  }

  private async configure(options: PaymentOptions): Promise<void> {
    const runtime = await this.loadRuntimeConfig();
    let envContent = (await this.fileExists(runtime.paths.envFile))
      ? await this.readFile(runtime.paths.envFile)
      : '# VPN SaaS environment\n';

    const gatewayCode = (options.gateway || (await this.prompt('Online gateway code', 'zarinpal'))).trim() || 'zarinpal';
    envContent = this.upsertEnvValue(envContent, 'PAYMENT_DEFAULT_GATEWAY', gatewayCode);

    if (options.card) {
      const cardHolder = options.cardHolder || (await this.prompt('Card holder name', ''));
      const cardNumber = options.cardNumber || (await this.prompt('Card number', ''));
      const iban = options.iban || (await this.prompt('IBAN / Sheba', ''));

      envContent = this.upsertEnvValue(envContent, 'PAYMENT_CARD_GATEWAY_ENABLED', 'true');
      envContent = this.upsertEnvValue(envContent, 'PAYMENT_CARD_GATEWAY_HOLDER', cardHolder);
      envContent = this.upsertEnvValue(envContent, 'PAYMENT_CARD_GATEWAY_NUMBER', cardNumber);
      envContent = this.upsertEnvValue(envContent, 'PAYMENT_CARD_GATEWAY_IBAN', iban);

      await this.saveRuntimeConfig((config) => ({
        ...config,
        payment: {
          ...(config as any).payment,
          defaultGateway: gatewayCode,
          cardToCard: {
            enabled: true,
            cardHolder,
            cardNumber,
            iban,
          },
        },
      }) as any);

      this.log('Card-to-card payment gateway updated.', 'success');
    }

    if (options.crypto) {
      const network = (options.network || (await this.prompt('Crypto network', 'USDT_TRC20'))).trim() || 'USDT_TRC20';
      const address = options.address || (await this.prompt('Wallet address', ''));

      envContent = this.upsertEnvValue(envContent, 'PAYMENT_CRYPTO_GATEWAY_ENABLED', 'true');
      envContent = this.upsertEnvValue(envContent, 'PAYMENT_CRYPTO_GATEWAY_NETWORK', network);
      envContent = this.upsertEnvValue(envContent, 'PAYMENT_CRYPTO_GATEWAY_ADDRESS', address);

      await this.saveRuntimeConfig((config) => ({
        ...config,
        payment: {
          ...(config as any).payment,
          defaultGateway: gatewayCode,
          crypto: {
            enabled: true,
            network,
            address,
          },
        },
      }) as any);

      this.log('Crypto payment gateway updated.', 'success');
    }

    await this.writeFile(runtime.paths.envFile, envContent);
    this.log(`Payment settings saved to ${runtime.paths.envFile}.`, 'success');
  }

  private async showSettings(): Promise<void> {
    const runtime = await this.loadRuntimeConfig();
    const payment = (runtime as any).payment || {};
    const card = payment.cardToCard || {};
    const crypto = payment.crypto || {};

    console.log(`  Default Gateway: ${payment.defaultGateway || 'zarinpal'}`);
    console.log(`  Card-to-Card Enabled: ${card.enabled ? 'yes' : 'no'}`);
    console.log(`  Card Holder: ${card.cardHolder || '(not set)'}`);
    console.log(`  Card Number: ${card.cardNumber || '(not set)'}`);
    console.log(`  IBAN / Sheba: ${card.iban || '(not set)'}`);
    console.log(`  Crypto Enabled: ${crypto.enabled ? 'yes' : 'no'}`);
    console.log(`  Crypto Network: ${crypto.network || '(not set)'}`);
    console.log(`  Crypto Address: ${crypto.address || '(not set)'}`);
  }
}