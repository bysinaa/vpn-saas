import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import {
  CreateTicketInput,
  createTicketSchema,
  ReplyTicketInput,
  replyTicketSchema,
  UpdateTicketStatusInput,
  updateTicketStatusSchema,
} from './tickets.schemas';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(createTicketSchema))
  create(@Body() body: CreateTicketInput, @CurrentUser() user: AuthenticatedUser) {
    return this.tickets.create({
      userId: user.id,
      subject: body.subject,
      category: body.category,
      priority: body.priority,
      message: body.message,
      attachmentFileKey: body.attachmentFileKey,
    });
  }

  @Post(':publicId/reply')
  @UsePipes(new ZodValidationPipe(replyTicketSchema))
  reply(
    @Param('publicId') publicId: string,
    @Body() body: ReplyTicketInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tickets.reply({
      ticketPublicId: publicId,
      senderId: user.id,
      senderRole: 'USER',
      message: body.message,
      attachmentFileKey: body.attachmentFileKey,
    });
  }

  @Get(':publicId/messages')
  getMessages(
    @Param('publicId') publicId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tickets.getMessages(publicId, user.id, 'USER');
  }

  @Get('mine')
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ) {
    return this.tickets.listMine(user.id, query);
  }

  // ---- Agent/Admin ----
  @Get('admin/all')
  @RequirePermissions(['read:tickets'])
  listAll(@Query() query: Record<string, unknown>) {
    return this.tickets.listAll(query);
  }

  @Post('admin/:publicId/reply')
  @RequirePermissions(['reply:tickets'])
  @UsePipes(new ZodValidationPipe(replyTicketSchema))
  agentReply(
    @Param('publicId') publicId: string,
    @Body() body: ReplyTicketInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tickets.reply({
      ticketPublicId: publicId,
      senderId: user.id,
      senderRole: 'AGENT',
      message: body.message,
      attachmentFileKey: body.attachmentFileKey,
    });
  }

  @Patch('admin/:publicId/status')
  @RequirePermissions(['manage:tickets'])
  @UsePipes(new ZodValidationPipe(updateTicketStatusSchema))
  updateStatus(
    @Param('publicId') publicId: string,
    @Body() body: UpdateTicketStatusInput,
  ) {
    return this.tickets.updateStatus(publicId, {
      status: body.status,
      assigneeId: body.assigneeId ? BigInt(body.assigneeId) : undefined,
    });
  }
}
