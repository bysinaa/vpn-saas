import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { XuiService } from './xui.service';
import type { XuiCreateClientInput, XuiUpdateClientInput } from './xui.types';

@Controller()
export class XuiController {
  constructor(private readonly xui: XuiService) {}

  @Get('/admin/xui/status')
  getStatus() {
    return this.xui.getStatus();
  }

  @Post('/admin/xui/login')
  login() {
    return this.xui.login();
  }

  @Post('/admin/xui/logout')
  logout() {
    return this.xui.logout();
  }

  @Get('/admin/xui/session')
  checkSession() {
    return this.xui.checkSession();
  }

  @Get('/admin/xui/inbounds')
  getInbounds() {
    return this.xui.getInbounds();
  }

  @Get('/admin/xui/inbounds/:id')
  getInbound(@Param('id') id: string) {
    return this.xui.getInbound(Number(id));
  }

  @Post('/admin/xui/clients')
  createClient(@Body() input: XuiCreateClientInput) {
    return this.xui.createClient(input);
  }

  @Patch('/admin/xui/clients/:email')
  updateClient(@Param('email') email: string, @Body() input: XuiUpdateClientInput) {
    return this.xui.updateClient(email, input);
  }

  @Delete('/admin/xui/clients/:email')
  deleteClient(@Param('email') email: string) {
    return this.xui.deleteClient(email);
  }

  @Get('/admin/xui/clients/:email/traffic')
  getClientTraffic(@Param('email') email: string) {
    return this.xui.getClientTraffic(email);
  }

  @Post('/admin/xui/test')
  testConnection() {
    return this.xui.testConnection();
  }
}