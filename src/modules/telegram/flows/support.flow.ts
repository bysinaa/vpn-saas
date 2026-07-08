import { Injectable } from '@nestjs/common';
import type { Context } from 'telegraf';
import { PrismaService } from '@/common/prisma/prisma.service';
import { BotRuntime } from '../bot-runtime';
import { t } from '../i18n';
import {
  mainMenuKeyboard,
  supportMenuKeyboard,
  ticketCategoryKeyboard,
  ticketsListKeyboard,
  ticketDetailKeyboard,
  cancelKeyboard,
} from '../keyboards';
import { formatDate } from '../format.util';
import { TicketsService } from '../../tickets/tickets.service';
import { TICKET_CATEGORIES, type TicketCategory } from '../telegram.types';

const TICKETS_PAGE_SIZE = 6;

/**
 * SupportFlow - "🎧 Support" screen + full ticket lifecycle.
 *
 * States:
 *   support_awaiting_category  -> category picker
 *   support_awaiting_subject   -> ask for subject text
 *   support_awaiting_message   -> ask for message text (+ optional photo)
 *   ticket_awaiting_reply      -> user is composing a reply to a ticket
 *
 * Actions:
 *   newticket           -> start new-ticket flow (category picker)
 *   tcat:<CAT>          -> category chosen, ask subject
 *   tickets:<STATUS>    -> list open/closed tickets (paginated)
 *   ticket:<id>         -> show ticket detail
 *   tkview:<id>         -> view all messages of a ticket
 *   tkreply:<id>        -> enter reply mode
 *   tkclose:<id>        -> close a ticket
 *   tkpage:<n>          -> paginate ticket list
 */
@Injectable()
export class SupportFlow {
  constructor(
    private readonly runtime: BotRuntime,
    private readonly prisma: PrismaService,
    private readonly tickets: TicketsService,
  ) {}

  /** Show the support main menu (`support`). */
  async show(ctx: Context): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }
    await this.runtime.pushMenu(telegramId, 'support');
    await this.runtime.setState(telegramId, 'idle');
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'support.title'), supportMenuKeyboard(locale), { parseMode: 'Markdown' });
  }

  /** Start the new-ticket flow: show category picker (`newticket`). */
  async startNewTicket(ctx: Context, preselectCategory?: string, reportSubId?: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }

    // If a category was pre-selected (e.g. from subscription "report problem"),
    // skip the picker and go straight to asking for the subject.
    if (preselectCategory && TICKET_CATEGORIES.includes(preselectCategory as TicketCategory)) {
      await this.runtime.setState(telegramId, 'support_awaiting_subject', {
        ticketCategory: preselectCategory,
        reportSubId,
      });
      await this.runtime.pushMenu(telegramId, 'ticket_categories');
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, t(locale, 'support.subject.prompt'), cancelKeyboard(locale));
      return;
    }

    await this.runtime.setState(telegramId, 'support_awaiting_category', { reportSubId });
    await this.runtime.pushMenu(telegramId, 'ticket_categories');
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'support.category.title'), ticketCategoryKeyboard(locale), { parseMode: 'Markdown' });
  }

  /** Category chosen (`tcat:<CAT>`): persist + ask for subject. */
  async onSelectCategory(ctx: Context, category: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) return;
    await this.runtime.setState(telegramId, 'support_awaiting_subject', { ticketCategory: category });
    await this.runtime.alert(ctx);
    await this.runtime.render(ctx, t(locale, 'support.subject.prompt'), cancelKeyboard(locale));
  }

  /** Subject entered: ask for the message body. Returns true if handled. */
  async onSubject(ctx: Context, text: string): Promise<boolean> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId || session.state !== 'support_awaiting_subject') return false;

    const subject = text.trim().slice(0, 120);
    if (!subject) {
      await this.runtime.send(ctx, t(locale, 'error.invalid.input'));
      return true;
    }

    await this.runtime.setState(telegramId, 'support_awaiting_message', {
      ticketCategory: session.data?.ticketCategory,
      ticketSubject: subject,
      reportSubId: session.data?.reportSubId,
    });
    await this.runtime.send(ctx, t(locale, 'support.message.prompt'), cancelKeyboard(locale));
    return true;
  }

  /** Message entered: create the ticket. Returns true if handled. */
  async onMessage(ctx: Context, text: string): Promise<boolean> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId || session.state !== 'support_awaiting_message') return false;

    const category = (session.data?.ticketCategory as string) ?? 'GENERAL';
    const subject = session.data?.ticketSubject as string;
    const message = text.trim().slice(0, 4000);
    if (!message) {
      await this.runtime.send(ctx, t(locale, 'error.invalid.input'));
      return true;
    }

    try {
      const ticket = await this.tickets.create({
        userId: session.userId,
        subject,
        category,
        priority: 'NORMAL',
        message,
      });
      await this.runtime.clearState(telegramId);
      await this.runtime.resetMenu(telegramId, 'main');
      await this.runtime.send(
        ctx,
        t(locale, 'support.created', { id: ticket.publicId.slice(0, 8) }),
        mainMenuKeyboard(locale),
      );
    } catch (err: any) {
      await this.runtime.send(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
    return true;
  }

  /** List the user's tickets filtered by status (`tickets:<STATUS>`). */
  async showList(ctx: Context, status: 'OPEN' | 'CLOSED', page = 0): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }

    try {
      // For "OPEN" we include all non-closed statuses; for "CLOSED" just CLOSED.
      const statusFilter = status === 'OPEN' ? { not: 'CLOSED' } : 'CLOSED';
      const result = await this.tickets.listMine(session.userId, {
        page: page + 1,
        limit: TICKETS_PAGE_SIZE,
        status: statusFilter,
      });
      await this.runtime.pushMenu(telegramId, 'tickets_list');
      await this.runtime.setState(telegramId, 'idle', { ticketListStatus: status, ticketPage: page });
      await this.runtime.alert(ctx);

      if (!result.data.length) {
        await this.runtime.render(ctx, t(locale, 'support.empty'), supportMenuKeyboard(locale), { parseMode: 'Markdown' });
        return;
      }

      const totalPages = Math.max(1, Math.ceil(result.meta.total / TICKETS_PAGE_SIZE));
      const kbItems = result.data.map((tk) => ({
        publicId: tk.publicId,
        label: `#${tk.publicId.slice(0, 8)} ${tk.subject} (${tk.status})`,
      }));
      await this.runtime.render(
        ctx,
        `${t(locale, status === 'OPEN' ? 'support.openTickets' : 'support.closedTickets')}\n\n${t(locale, 'subs.select')}`,
        ticketsListKeyboard(locale, kbItems, page, totalPages),
        { parseMode: 'Markdown' },
      );
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Show ticket detail (`ticket:<id>`). */
  async showDetail(ctx: Context, ticketPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }

    try {
      const ticket = await this.tickets.listMine(session.userId, { page: 1, limit: 100 });
      const tk = ticket.data.find((x) => x.publicId === ticketPublicId);
      if (!tk) {
        await this.runtime.alert(ctx, t(locale, 'error.not.found'));
        return;
      }

      await this.runtime.pushMenu(telegramId, 'ticket_detail');
      await this.runtime.setState(telegramId, 'idle', { ticketPublicId });
      await this.runtime.alert(ctx);

      const isOpen = tk.status !== 'CLOSED';
      const msg =
        `${t(locale, 'ticket.title', { id: tk.publicId.slice(0, 8) })}\n\n` +
        `${t(locale, 'support.category.title')}: ${t(locale, `support.category.${tk.category}`)}\n` +
        `Subject: ${tk.subject}\n` +
        `${t(locale, 'sub.detail.status')}: ${tk.status}\n` +
        `${t(locale, 'profile.registered')}: ${formatDate(tk.createdAt, locale)}`;
      await this.runtime.render(ctx, msg, ticketDetailKeyboard(locale, tk.publicId, isOpen), { parseMode: 'Markdown' });
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** View all messages in a ticket (`tkview:<id>`). */
  async viewMessages(ctx: Context, ticketPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) {
      await this.runtime.alert(ctx, t(locale, 'auth.required'));
      return;
    }

    try {
      const messages = await this.tickets.getMessages(ticketPublicId, session.userId, 'USER');
      await this.runtime.alert(ctx);

      if (!messages.length) {
        await this.runtime.render(ctx, '—', mainMenuKeyboard(locale));
        return;
      }

      const lines = messages.map((m) => {
        const who = m.senderRole === 'USER' ? '🙋' : '🎧';
        return `${who} ${m.body}\n   _${formatDate(m.createdAt, locale)}_`;
      });
      const msg = lines.join('\n\n');
      await this.runtime.render(ctx, msg, mainMenuKeyboard(locale), { parseMode: 'Markdown' });
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Enter reply mode for a ticket (`tkreply:<id>`). */
  async startReply(ctx: Context, ticketPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) return;

    // Verify the ticket is open before allowing a reply.
    try {
      const ticket = await this.tickets.listMine(session.userId, { page: 1, limit: 100 });
      const tk = ticket.data.find((x) => x.publicId === ticketPublicId);
      if (!tk) {
        await this.runtime.alert(ctx, t(locale, 'error.not.found'));
        return;
      }
      if (tk.status === 'CLOSED') {
        await this.runtime.alert(ctx);
        await this.runtime.render(ctx, t(locale, 'support.ticketClosed'), mainMenuKeyboard(locale), { parseMode: 'Markdown' });
        return;
      }
      await this.runtime.setState(telegramId, 'ticket_awaiting_reply', { ticketPublicId });
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, t(locale, 'support.reply.prompt'), cancelKeyboard(locale));
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }

  /** Handle the reply text. Returns true if handled. */
  async onReply(ctx: Context, text: string): Promise<boolean> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId || session.state !== 'ticket_awaiting_reply') return false;

    const ticketPublicId = session.data?.ticketPublicId as string | undefined;
    if (!ticketPublicId) return false;

    const message = text.trim().slice(0, 4000);
    if (!message) {
      await this.runtime.send(ctx, t(locale, 'error.invalid.input'));
      return true;
    }

    try {
      await this.tickets.reply({
        ticketPublicId,
        senderId: session.userId,
        senderRole: 'USER',
        message,
      });
      await this.runtime.clearState(telegramId);
      await this.runtime.resetMenu(telegramId, 'main');
      await this.runtime.send(ctx, t(locale, 'support.reply.sent'), mainMenuKeyboard(locale));
    } catch (err: any) {
      await this.runtime.send(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
    return true;
  }

  /** Close a ticket (`tkclose:<id>`). */
  async closeTicket(ctx: Context, ticketPublicId: string): Promise<void> {
    const telegramId = ctx.from?.id?.toString()!;
    const locale = await this.runtime.getLocale(telegramId);
    const session = await this.runtime.getSession(telegramId);
    if (!session.userId) return;

    try {
      await this.tickets.updateStatus(ticketPublicId, { status: 'CLOSED' });
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, t(locale, 'support.ticketClosed'), mainMenuKeyboard(locale), { parseMode: 'Markdown' });
    } catch (err: any) {
      await this.runtime.alert(ctx);
      await this.runtime.render(ctx, this.runtime.translateError(locale, err), mainMenuKeyboard(locale));
    }
  }
}
