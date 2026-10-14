import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockTransport() {
  return {
    sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
  };
}

function createMockConnectionManager(mockTransport: ReturnType<typeof createMockTransport>) {
  return {
    getAccount: vi.fn().mockReturnValue({
      name: 'test',
      email: 'test@example.com',
      fullName: 'Test User',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn(),
    getSmtpTransport: vi.fn().mockResolvedValue(mockTransport),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
}

function createMockRateLimiter(allowed = true) {
  return {
    tryConsume: vi.fn().mockReturnValue(allowed),
    remaining: vi.fn().mockReturnValue(allowed ? 9 : 0),
  } as unknown as RateLimiter;
}

function createMockImapService() {
  return {
    appendToSent: vi.fn().mockResolvedValue('Sent'),
  };
}

function asImapService(imap: ReturnType<typeof createMockImapService>) {
  return imap as unknown as ImapService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SmtpService', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let connections: ReturnType<typeof createMockConnectionManager>;
  let rateLimiter: RateLimiter;
  let imap: ReturnType<typeof createMockImapService>;
  let service: SmtpService;

  beforeEach(() => {
    transport = createMockTransport();
    connections = createMockConnectionManager(transport);
    rateLimiter = createMockRateLimiter(true);
    imap = createMockImapService();
    service = new SmtpService(connections, rateLimiter, asImapService(imap));
  });

  describe('sendEmail', () => {
    it('sends email via SMTP transport', async () => {
      const result = await service.sendEmail('test', {
        to: ['recipient@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result).toEqual({
        messageId: '<test@example.com>',
        status: 'sent',
        sentCopy: { status: 'saved', mailbox: 'Sent' },
      });
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: { address: 'test@example.com', name: 'Test User' },
          to: 'recipient@example.com',
          subject: 'Hello',
          text: 'World',
        }),
      );
    });

    it('throws when rate limited', async () => {
      rateLimiter = createMockRateLimiter(false);
      service = new SmtpService(connections, rateLimiter, asImapService(imap));

      await expect(
        service.sendEmail('test', {
          to: ['recipient@example.com'],
          subject: 'Hello',
          body: 'World',
        }),
      ).rejects.toThrow('Rate limit exceeded');

      expect(transport.sendMail).not.toHaveBeenCalled();
    });

    it('includes CC and BCC when provided', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Test',
        body: 'Body',
        cc: ['cc1@example.com', 'cc2@example.com'],
        bcc: ['bcc@example.com'],
      });

      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: 'cc1@example.com, cc2@example.com',
          bcc: 'bcc@example.com',
        }),
      );
    });

    it('sends as HTML when html=true', async () => {
      await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'HTML Test',
        body: '<h1>Hello</h1>',
        html: true,
      });

      const call = transport.sendMail.mock.calls[0][0];
      expect(call.html).toBe('<h1>Hello</h1>');
      expect(call.text).toBeUndefined();
    });
  });

  describe('Sent copy', () => {
    it('stores the sent message, including Bcc, in the Sent folder', async () => {
      await service.sendEmail('test', {
        from: 'alias@example.org',
        fromName: 'Alias',
        to: ['a@example.com'],
        bcc: ['hidden@example.com'],
        subject: 'Copy me',
        body: 'Body',
      });

      const sent = transport.sendMail.mock.calls[0][0];
      expect(sent.messageId).toMatch(/^<[0-9a-f-]+@example\.org>$/);

      const raw = imap.appendToSent.mock.calls[0][1].toString();
      expect(raw).toContain(`Message-ID: ${sent.messageId}`);
      expect(raw).toContain('From: Alias <alias@example.org>');
      expect(raw).toContain('Bcc: hidden@example.com');
      expect(raw).toContain('Subject: Copy me');
    });

    it('reports a failed copy without failing the send', async () => {
      imap.appendToSent.mockRejectedValue(new Error('NO [TRYCREATE]'));

      const result = await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result.status).toBe('sent');
      expect(result.sentCopy).toEqual({ status: 'failed', error: 'NO [TRYCREATE]' });
    });

    it('reports a missing Sent folder', async () => {
      imap.appendToSent.mockResolvedValue(null);

      const result = await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(result.sentCopy).toEqual({ status: 'skipped', reason: 'no Sent folder found' });
    });

    it('skips providers that store sent mail themselves', async () => {
      connections.getAccount.mockReturnValue({
        ...connections.getAccount('test'),
        smtp: { host: 'smtp.gmail.com', port: 465, tls: true, starttls: false, verifySsl: true },
      });

      const result = await service.sendEmail('test', {
        to: ['a@example.com'],
        subject: 'Hello',
        body: 'World',
      });

      expect(imap.appendToSent).not.toHaveBeenCalled();
      expect(result.sentCopy?.status).toBe('skipped');
    });
  });
});
