import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { WalletService } from '../wallet/wallet.service';
import { PlansService } from '../plans/plans.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { OrdersService } from '../orders/orders.service';
import { config } from '@/config';
import { BusinessException } from '@/common/exceptions/business.exception';
import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export interface MiniAppUser {
  id: string;
  publicId: string;
  telegramId: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  language: string;
  status: string;
  walletBalanceMinor: string;
}

export interface MiniAppSession {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: MiniAppUser;
}

/**
 * MiniAppService - backend for the Telegram Mini App (Web App).
 *
 * Validates Telegram WebApp initData (HMAC-SHA256) to authenticate users,
 * then mints JWT session tokens. Also aggregates dashboard data for the
 * Mini App home screen in a single round-trip.
 */
@Injectable()
export class MiniAppService {
  private readonly logger = new Logger(MiniAppService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly wallet: WalletService,
    private readonly plans: PlansService,
    @Inject(forwardRef(() => SubscriptionsService))
    private readonly subscriptions: SubscriptionsService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * Authenticate a Mini App user via Telegram WebApp initData.
   * Validates the HMAC, extracts the user, mints a JWT session.
   *
   * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
   */
  async authenticate(initData: string): Promise<MiniAppSession> {
    const validated = this.validateInitData(initData);
    if (!validated) {
      throw BusinessException.unauthorized('Invalid Telegram WebApp initData');
    }

    const userData = this.parseUserData(validated.user);
    const result = await this.auth.mintForTelegramUser({
      telegramId: userData.id,
      username: userData.username,
      firstName: userData.first_name,
      lastName: userData.last_name,
      languageCode: userData.language_code,
    });

    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(result.user.id) },
      include: { wallet: true },
    });
    if (!user) throw BusinessException.notFound('User not found');

    return {
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      expiresIn: result.tokens.expiresIn,
      user: {
        id: user.id.toString(),
        publicId: user.publicId,
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        language: user.language,
        status: user.status,
        walletBalanceMinor: user.wallet?.balance?.toString() ?? '0',
      },
    };
  }

  /**
   * Get the Mini App dashboard data in a single call:
   * user profile + wallet + active subscriptions + available plans.
   */
  async getDashboard(userId: bigint) {
    const [user, wallet, subs, plans] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: { wallet: true },
      }),
      this.wallet.getBalance(userId),
      this.subscriptions.listMine(userId, { page: '1', limit: '5' }),
      this.plans.listVisible(),
    ]);

    if (!user) throw BusinessException.notFound('User not found');

    return {
      user: {
        id: user.id.toString(),
        publicId: user.publicId,
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        language: user.language,
        status: user.status,
      },
      wallet: {
        balanceMinor: wallet.balance?.toString() ?? '0',
      },
      subscriptions: subs.data,
      plans,
    };
  }

  // ---- Telegram initData validation ----

  /**
   * Validates the Telegram WebApp initData string using HMAC-SHA256.
   * Returns the parsed params map if valid, null otherwise.
   */
  private validateInitData(initData: string): Record<string, string> | null {
    try {
      const params = new URLSearchParams(initData);
      const hash = params.get('hash');
      if (!hash) return null;
      params.delete('hash');

      // Build the data-check string (sorted key=value pairs joined by \n)
      const dataCheckString = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');

      // Derive secret key: HMAC-SHA256("WebAppData", botToken)
      const secretKey = createHmac('sha256', 'WebAppData')
        .update(config.telegram.botToken)
        .digest();

      const computedHash = createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

      // Timing-safe comparison
      const a = Buffer.from(hash, 'hex');
      const b = Buffer.from(computedHash, 'hex');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return null;
      }

      // Check auth_date freshness (max 24h old)
      const authDate = parseInt(params.get('auth_date') ?? '0', 10);
      if (!authDate) return null;
      const ageSeconds = Date.now() / 1000 - authDate;
      if (ageSeconds > 86400) return null;

      return Object.fromEntries(params.entries());
    } catch {
      return null;
    }
  }

  private parseUserData(userJson: string): {
    id: string;
    username?: string;
    first_name?: string;
    last_name?: string;
    language_code?: string;
  } {
    try {
      return JSON.parse(userJson);
    } catch {
      throw BusinessException.unauthorized('Invalid user data in initData');
    }
  }
}
