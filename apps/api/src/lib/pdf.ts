import PDFDocument from 'pdfkit';

/** Minimal, dependency-light PDF rendering for receipts and exported reports. */

function money(amount: number, currency = 'KES') {
  return `${currency} ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function docToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function header(doc: PDFKit.PDFDocument, title: string, subtitle?: string) {
  doc.fontSize(18).fillColor('#0f766e').text('MEDI SYNC', { continued: false });
  doc.fontSize(9).fillColor('#475569').text('Hospital Management System · Nairobi, Kenya');
  doc.moveDown(0.5);
  doc.fontSize(14).fillColor('#0f172a').text(title);
  if (subtitle) doc.fontSize(9).fillColor('#475569').text(subtitle);
  doc.moveDown(0.8);
  doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor('#cbd5e1').stroke();
  doc.moveDown(0.8);
}

export interface ReceiptData {
  receiptNo: string;
  invoiceNumber: string;
  patientName: string;
  mrn: string;
  amount: number;
  method: string;
  reference?: string | null;
  paidAt: Date;
  currency: string;
  items: { description: string; quantity: number; amount: number }[];
  total: number;
  balance: number;
  receivedBy?: string | null;
}

export async function renderReceiptPdf(data: ReceiptData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A5', margin: 40 });
  header(doc, 'Payment receipt', `Receipt ${data.receiptNo} · ${data.paidAt.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })}`);

  doc.fontSize(10).fillColor('#0f172a');
  doc.text(`Patient: ${data.patientName}`);
  doc.text(`MRN: ${data.mrn}`);
  doc.text(`Invoice: ${data.invoiceNumber}`);
  doc.moveDown(0.8);

  const tableTop = doc.y;
  doc.fontSize(8).fillColor('#475569').text('Description', 40, tableTop);
  doc.text('Qty', 300, tableTop, { width: 40, align: 'right' });
  doc.text('Amount', 350, tableTop, { width: 95, align: 'right' });
  doc.moveDown(0.4);
  doc.moveTo(40, doc.y).lineTo(455, doc.y).strokeColor('#e2e8f0').stroke();
  doc.moveDown(0.4);

  doc.fontSize(9).fillColor('#334155');
  for (const item of data.items.slice(0, 12)) {
    const y = doc.y;
    doc.text(item.description.slice(0, 60), 40, y, { width: 250 });
    doc.text(String(item.quantity), 300, y, { width: 40, align: 'right' });
    doc.text(money(item.amount, data.currency), 350, y, { width: 95, align: 'right' });
    doc.moveDown(0.3);
  }
  doc.moveDown(0.4);
  doc.moveTo(40, doc.y).lineTo(455, doc.y).strokeColor('#cbd5e1').stroke();
  doc.moveDown(0.4);

  doc.fontSize(10).fillColor('#0f172a');
  doc.text(`Invoice total: ${money(data.total, data.currency)}`, { align: 'right' });
  doc.fontSize(12).fillColor('#0f766e').text(`Amount paid: ${money(data.amount, data.currency)}`, { align: 'right' });
  doc.fontSize(10).fillColor('#475569').text(`Balance: ${money(data.balance, data.currency)}`, { align: 'right' });
  doc.moveDown(0.5);
  doc.fontSize(9).text(`Method: ${data.method}${data.reference ? ` · Ref ${data.reference}` : ''}`);
  if (data.receivedBy) doc.text(`Received by: ${data.receivedBy}`);
  doc.moveDown(1);
  doc.fontSize(7).fillColor('#64748b').text(
    'This is a system-generated receipt. Keep it for your records. Queries: billing@medisync.example',
  );
  return docToBuffer(doc);
}

export interface ReportTable {
  title: string;
  subtitle?: string;
  columns: { key: string; label: string; width: number; align?: 'left' | 'right' }[];
  rows: Record<string, string | number | null>[];
  summary?: { label: string; value: string }[];
}

export async function renderReportPdf(report: ReportTable): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  header(doc, report.title, report.subtitle);

  if (report.summary?.length) {
    doc.fontSize(10).fillColor('#0f172a');
    for (const line of report.summary) {
      doc.text(`${line.label}: ${line.value}`);
    }
    doc.moveDown(0.8);
  }

  const startX = 40;
  let y = doc.y;
  doc.fontSize(8).fillColor('#475569');
  for (const col of report.columns) {
    doc.text(col.label, startX + report.columns.slice(0, report.columns.indexOf(col)).reduce((a, c) => a + c.width, 0), y, {
      width: col.width,
      align: col.align ?? 'left',
    });
  }
  doc.moveDown(0.4);
  doc.moveTo(startX, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor('#cbd5e1').stroke();
  doc.moveDown(0.3);

  doc.fillColor('#334155').fontSize(8.5);
  for (const row of report.rows) {
    y = doc.y;
    if (y > doc.page.height - 70) {
      doc.addPage();
      y = doc.y;
    }
    let x = startX;
    for (const col of report.columns) {
      const value = row[col.key];
      doc.text(value === null || value === undefined ? '-' : String(value), x, y, {
        width: col.width,
        align: col.align ?? 'left',
        lineBreak: false,
      });
      x += col.width;
    }
    doc.moveDown(0.35);
  }
  doc.moveDown(1);
  doc.fontSize(7).fillColor('#64748b').text(
    `Generated ${new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' })} · MEDI SYNC`,
  );
  return docToBuffer(doc);
}
