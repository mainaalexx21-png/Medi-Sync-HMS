import { prisma } from '../db';
import { env } from '../env';
import { logger } from '../lib/logger';
import { publish } from '../lib/events';

/**
 * Notification + messaging providers.
 *
 * Everything is behind an interface so a real provider (Africa's Talking for
 * SMS, Resend/Postmark for email) drops in without touching business logic.
 * The console provider is the default for dev/test: it never prints PHI, only
 * the message kind + recipient id.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  kind: string;
}

export interface SmsMessage {
  to: string;
  body: string;
  kind: string;
}

export interface NotificationProvider {
  sendEmail(message: EmailMessage): Promise<void>;
  sendSms(message: SmsMessage): Promise<void>;
}

const consoleProvider: NotificationProvider = {
  async sendEmail(message) {
    logger.info('email.sent', { kind: message.kind, provider: 'console' });
  },
  async sendSms(message) {
    logger.info('sms.sent', { kind: message.kind, provider: 'console' });
  },
};

/**
 * Real SMS via Africa's Talking (Kenya) - enabled by setting credentials.
 * Kept dependency-free: plain HTTPS call.
 */
const africastalkingProvider: NotificationProvider = {
  async sendEmail(message) {
    logger.warn('email.provider.unsupported', { kind: message.kind });
  },
  async sendSms(message) {
    const username = process.env.AT_USERNAME;
    const apiKey = process.env.AT_API_KEY;
    if (!username || !apiKey) {
      return consoleProvider.sendSms(message);
    }
    const params = new URLSearchParams({
      username,
      to: message.to,
      message: message.body,
      from: process.env.AT_SENDER_ID ?? '',
    });
    const res = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });
    if (!res.ok) logger.error('sms.failed', { status: res.status, kind: message.kind });
  },
};

export const notifications: NotificationProvider =
  env.smsProvider === 'africastalking' ? africastalkingProvider : consoleProvider;

/** In-app notification + live SSE push to the patient/staff header bell. */
export async function notifyUser(params: {
  userId: string;
  title: string;
  body: string;
  type?: 'INFO' | 'APPOINTMENT' | 'LAB' | 'BILL' | 'STOCK';
  link?: string;
}) {
  const notification = await prisma.notification.create({
    data: {
      userId: params.userId,
      title: params.title,
      body: params.body,
      type: params.type ?? 'INFO',
      link: params.link ?? null,
    },
  });
  publish(`user:${params.userId}`, 'notification', {
    id: notification.id,
    title: notification.title,
    type: notification.type,
    createdAt: notification.createdAt,
  });
  return notification;
}

/** Reminder stub: called by the appointment service after booking. */
export async function sendAppointmentReminder(params: {
  email?: string | null;
  phone?: string | null;
  when: Date;
  reference: string;
}) {
  const when = params.when.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  if (params.email) {
    await notifications.sendEmail({
      to: params.email,
      kind: 'appointment.reminder',
      subject: 'MEDI SYNC appointment reminder',
      body: `Your appointment (${params.reference}) is scheduled for ${when}.`,
    });
  }
  if (params.phone) {
    await notifications.sendSms({
      to: params.phone,
      kind: 'appointment.reminder',
      body: `MEDI SYNC: appointment ${params.reference} on ${when}. Reply CANCEL to cancel.`,
    });
  }
}
