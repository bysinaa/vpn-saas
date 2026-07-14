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
export declare class PaymentCommand extends BaseCommand {
    execute(options: PaymentOptions): Promise<void>;
    private showMenu;
    private configure;
    private showSettings;
}
//# sourceMappingURL=payment.d.ts.map