import crypto from 'node:crypto';
import { prisma } from '../db';

function pad(n: number, width = 4) {
  return String(n).padStart(width, '0');
}

/** Medical record number: MS-000123 (sequence based, readable at the desk). */
export async function nextMrn(): Promise<string> {
  const count = await prisma.patient.count();
  let candidate = `MS-${pad(count + 1001, 5)}`;
  // Collision-safe even if rows were deleted.
  for (let i = 0; i < 50; i += 1) {
    const exists = await prisma.patient.findUnique({ where: { mrn: candidate } });
    if (!exists) return candidate;
    candidate = `MS-${pad(count + 1002 + i, 5)}`;
  }
  return `MS-${Date.now().toString(36).toUpperCase()}`;
}

function stamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`;
}

/** Human-quotable document numbers; random suffix avoids write contention. */
export function invoiceNumber(date = new Date()) {
  return `INV-${stamp(date)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
export function receiptNumber(date = new Date()) {
  return `RCT-${stamp(date)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
export function labSampleBarcode(date = new Date()) {
  return `LAB-${stamp(date)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/** Queue ticket: per department per day, e.g. B-014. */
export async function nextTicketNo(departmentId: string): Promise<string> {
  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { code: true },
  });
  const prefix = (dept?.code ?? 'Q').slice(0, 2).toUpperCase();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayCount = await prisma.queueEntry.count({
    where: { departmentId, createdAt: { gte: startOfDay } },
  });
  return `${prefix}-${pad(todayCount + 1, 3)}`;
}

export function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}
