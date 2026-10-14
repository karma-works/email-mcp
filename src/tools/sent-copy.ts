/**
 * Formats the Sent-folder outcome of a send for tool output.
 */

import type { SentCopyResult } from '../types/index.js';

export function formatSentCopy(sentCopy: SentCopyResult | undefined): string {
  if (!sentCopy) return '';
  switch (sentCopy.status) {
    case 'saved':
      return `\nSent copy: saved to "${sentCopy.mailbox}"`;
    case 'skipped':
      return `\nSent copy: not saved (${sentCopy.reason})`;
    default:
      return `\n⚠️ Sent copy: not saved (${sentCopy.error}). The email itself was sent.`;
  }
}
