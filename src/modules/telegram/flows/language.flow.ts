import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import type { BotLocale } from '../telegram.types';
import { BOT_ACTIONS } from '../telegram.types';
import { languageKeyboard, mainMenuKeyboard } from '../keyboards';

/**
 * LanguageFlow - handles onboarding language selection + the "🌐 Language"
 * menu entry. Changing the language immediately re-renders the menu in the
 * new locale and persists the preference both in the bot session and on the
 * User row (so the web app / mini app reads the same preference).
 */
@Injectable()
export class LanguageFlow {
  constructor(private readonly runtime: BotRuntime) {}

  /** Show the language picker (used on first start and from the menu). */
  async show(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const brand = await this.runtime.getBrandName();
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.send(ctx, t(locale, 'start.welcome', { brand }), languageKeyboard());
  }

  /** Handle a language selection callback. */
  async onSelect(ctx: Context, locale: BotLocale): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    await this.runtime.setLocale(telegramId, locale);

    // Persist onto the User row so the web app / mini app reads the same
    // preference. The session keeps a fast in-memory copy in Redis.
    const session = await this.runtime.getSession(telegramId);
    if (session.userId) {
      await this.runtime.persistUserLanguage(session.userId, locale);
    }

    await this.runtime.alert(ctx);
    await this.runtime.send(ctx, t(locale, 'language.changed'), mainMenuKeyboard(locale));
    await this.runtime.resetMenu(telegramId, 'main');
  }

  /** Re-render the main menu in the current locale. */
  async home(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    await this.runtime.alert(ctx);
    await this.runtime.resetMenu(telegramId, 'main');
    await this.runtime.render(ctx, t(locale, 'menu.title'), mainMenuKeyboard(locale));
  }

  /** Wire-up helper for the action regexes. */
  static readonly actions = {
    LANGUAGE_FA: BOT_ACTIONS.LANGUAGE_FA,
    LANGUAGE_EN: BOT_ACTIONS.LANGUAGE_EN,
  } as const;
}
