jest.mock('./payments.service', () => ({ PaymentsService: class {} }));

import { PaymentsController } from './payments.controller';

function replyHarness() {
  const reply: any = {
    header: jest.fn(),
    type: jest.fn(),
    send: jest.fn(),
  };
  reply.header.mockReturnValue(reply);
  reply.type.mockReturnValue(reply);
  reply.send.mockReturnValue(reply);
  return reply;
}

describe('PaymentsController online callback page', () => {
  it('renders a simple success page after verified settlement', async () => {
    const payments = { handleOnlineCallback: jest.fn().mockResolvedValue({ status: 'CONFIRMED' }) };
    const reply = replyHarness();
    await new PaymentsController(payments as any).onlineCallback('A-test', 'OK', reply);

    expect(reply.type).toHaveBeenCalledWith('text/html; charset=utf-8');
    expect(reply.send.mock.calls[0][0]).toContain('پرداخت موفقیت‌آمیز بود');
    expect(reply.send.mock.calls[0][0]).toContain('به ربات برگردید');
  });

  it('renders a safe failure page without exposing gateway errors', async () => {
    const payments = { handleOnlineCallback: jest.fn().mockRejectedValue(new Error('sensitive gateway detail')) };
    const reply = replyHarness();
    await new PaymentsController(payments as any).onlineCallback('A-test', 'OK', reply);

    expect(reply.send.mock.calls[0][0]).toContain('پرداخت تکمیل نشد');
    expect(reply.send.mock.calls[0][0]).not.toContain('sensitive gateway detail');
  });
});
