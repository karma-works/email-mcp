/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import { randomUUID } from 'node:crypto';
import type { SendMailOptions } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import type { IConnectionManager } from '../connections/types.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { Account, AccountConfig, SendResult, SentCopyResult } from '../types/index.js';
import type ImapService from './imap.service.js';

/** SMTP hosts that store a Sent copy themselves; appending would duplicate it. */
const SERVER_SAVES_SENT = [/(^|\.)gmail\.com$/i, /(^|\.)office365\.com$/i, /(^|\.)outlook\.com$/i];

export default class SmtpService {
  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      from?: string;
      fromName?: string;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    return this.deliver(accountName, account, {
      from: this.senderAddress(account, options),
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
    });
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  async replyToEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      body: string;
      replyAll?: boolean;
      html?: boolean;
      from?: string;
      fromName?: string;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Build recipient list
    const to = [original.from.address];
    const cc: string[] = [];

    if (options.replyAll) {
      // Add all original To recipients except ourselves
      original.to
        .filter((addr) => addr.address !== account.email && addr.address !== options.from)
        .forEach((addr) => {
          to.push(addr.address);
        });
      // Add CC recipients except ourselves
      (original.cc ?? [])
        .filter((addr) => addr.address !== account.email && addr.address !== options.from)
        .forEach((addr) => {
          cc.push(addr.address);
        });
    }

    // Build threading headers
    const references = [...(original.references ?? []), original.messageId].filter(Boolean);

    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    return this.deliver(accountName, account, {
      from: this.senderAddress(account, options),
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      ...(options.html ? { html: options.body } : { text: options.body }),
    });
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  async forwardEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      to: string[];
      body?: string;
      cc?: string[];
      from?: string;
      fromName?: string;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const subject = original.subject.startsWith('Fwd:')
      ? original.subject
      : `Fwd: ${original.subject}`;

    // Build forwarded message body
    const forwardHeader = [
      '',
      '---------- Forwarded message ----------',
      `From: ${original.from.name ? `${original.from.name} <${original.from.address}>` : original.from.address}`,
      `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${original.to.map((a) => a.address).join(', ')}`,
      '',
    ].join('\n');

    const originalBody = original.bodyText ?? original.bodyHtml ?? '';
    const fullBody = (options.body ?? '') + forwardHeader + originalBody;

    return this.deliver(accountName, account, {
      from: this.senderAddress(account, options),
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      text: fullBody,
    });
  }

  private senderAddress(account: Account, options: { from?: string; fromName?: string }) {
    return {
      address: options.from ?? account.email,
      name: options.fromName ?? account.fullName ?? '',
    };
  }

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------

  private checkRateLimit(accountName: string): void {
    if (!this.rateLimiter.tryConsume(accountName)) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  async sendDraft(accountName: string, draftId: number, mailbox?: string): Promise<SendResult> {
    this.checkRateLimit(accountName);

    // Fetch the draft via IMAP
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');

    const result = await this.deliver(accountName, account, {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to,
      cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : { text: draft.bodyText ?? '' }),
    });

    // Delete the draft after successful send
    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    return result;
  }

  // -------------------------------------------------------------------------
  // Delivery and Sent copy
  // -------------------------------------------------------------------------

  /**
   * Send via SMTP, then store the same message in the Sent folder.
   * SMTP does not do that by itself; mail clients do it after sending.
   */
  private async deliver(
    accountName: string,
    account: AccountConfig,
    mail: SendMailOptions,
  ): Promise<SendResult> {
    const message: SendMailOptions = {
      ...mail,
      messageId: mail.messageId ?? SmtpService.newMessageId(mail.from, account.email),
      date: mail.date ?? new Date(),
    };

    const transport = await this.connections.getSmtpTransport(accountName);
    const result = await transport.sendMail(message);
    const sentCopy = await this.saveSentCopy(accountName, account, message);

    return {
      messageId: result.messageId ?? String(message.messageId),
      status: 'sent',
      sentCopy,
    };
  }

  private async saveSentCopy(
    accountName: string,
    account: AccountConfig,
    message: SendMailOptions,
  ): Promise<SentCopyResult> {
    if (SERVER_SAVES_SENT.some((host) => host.test(account.smtp.host))) {
      return { status: 'skipped', reason: `${account.smtp.host} stores sent mail itself` };
    }
    try {
      const node = new MailComposer(message).compile();
      // The sender's own copy keeps Bcc, as mail clients do.
      node.keepBcc = true;
      const raw = await node.build();
      const mailbox = await this.imapService.appendToSent(accountName, raw);
      return mailbox
        ? { status: 'saved', mailbox }
        : { status: 'skipped', reason: 'no Sent folder found' };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  private static newMessageId(from: SendMailOptions['from'], fallback: string): string {
    let address = fallback;
    if (typeof from === 'string') address = from;
    else if (from && !Array.isArray(from)) address = from.address ?? fallback;
    const domain = /@([^>\s]+)>?\s*$/.exec(address)?.[1] ?? 'localhost';
    return `<${randomUUID()}@${domain}>`;
  }
}
